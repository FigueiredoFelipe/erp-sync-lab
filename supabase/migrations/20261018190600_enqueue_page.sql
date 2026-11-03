-- T6: enqueue a page of Source A and move its cursor in one transaction, plus the sync_run bookkeeping
-- (PLAN "Source A: incremental fetch", "How services reach internal").
-- Versions and names are compared with COLLATE "C" (byte order), the same order the TypeScript side uses.

-- ---------------------------------------------------------------- internal

-- p_messages: jsonb array of queue messages, each with source, sourceDocId and sourceVersion.
-- Skips a message whose version is <= the version already enqueued for its key, or that is already
-- dead-lettered at that version; sends the rest; raises enqueued_version; moves the cursor forward only.
-- Returns how many messages were sent.
create or replace function internal.enqueue_page(
  p_source text,
  p_messages jsonb,
  p_last_modified text,
  p_last_name text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payloads jsonb[];
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'enqueue_page: p_messages must be a jsonb array';
  end if;
  if p_last_modified is null or p_last_name is null then
    raise exception 'enqueue_page: the page position (modified, name) is required';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_messages) as m(msg)
    where m.msg ->> 'source' is distinct from p_source
       or coalesce(m.msg ->> 'sourceDocId', '') = ''
       or coalesce(m.msg ->> 'sourceVersion', '') = ''
  ) then
    raise exception 'enqueue_page: every message needs source = %, a sourceDocId and a sourceVersion', p_source;
  end if;

  with incoming as (
    -- One message per key: the highest version in the page (a page never repeats a key, but be safe).
    select distinct on (m.msg ->> 'sourceDocId')
      m.msg ->> 'sourceDocId' as doc_id,
      m.msg ->> 'sourceVersion' as version,
      m.msg
    from jsonb_array_elements(p_messages) as m(msg)
    order by m.msg ->> 'sourceDocId', (m.msg ->> 'sourceVersion') collate "C" desc
  ),
  candidates as (
    select i.* from incoming i
    where not exists (
      select 1 from public.dead_letter d
      where d.source = p_source and d.source_doc_id = i.doc_id and d.source_version = i.version
    )
  ),
  -- The version check and the raise are one conditional upsert, so two overlapping runs can't both
  -- send the same version: the row lock makes the second one see the first one's enqueued_version.
  raised as (
    insert into internal.record_version as rv (source, source_doc_id, enqueued_version)
    select p_source, c.doc_id, c.version from candidates c
    on conflict (source, source_doc_id) do update
      set enqueued_version = excluded.enqueued_version
      where rv.enqueued_version is null
         or rv.enqueued_version collate "C" < excluded.enqueued_version collate "C"
    returning rv.source_doc_id
  )
  select coalesce(array_agg(c.msg order by c.doc_id), '{}')
  into v_payloads
  from candidates c
  join raised r on r.source_doc_id = c.doc_id;

  if cardinality(v_payloads) > 0 then
    perform pgmq.send_batch('invoice_events', v_payloads);
  end if;

  -- Forward only: a page re-read inside the overlap window never moves the cursor back.
  insert into internal.sync_cursor as sc (source, stream, cursor_modified, cursor_name, updated_at)
  values (p_source, 'invoices', p_last_modified::timestamp(6), p_last_name, now())
  on conflict (source, stream) do update
    set cursor_modified = excluded.cursor_modified,
        cursor_name = excluded.cursor_name,
        updated_at = excluded.updated_at
    where (excluded.cursor_modified, excluded.cursor_name collate "C")
        > (sc.cursor_modified, sc.cursor_name collate "C");

  return cardinality(v_payloads);
end;
$$;

revoke all on function internal.enqueue_page(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function internal.enqueue_page(text, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------- public wrappers (service_role only)

create or replace function public.enqueue_page(
  p_source text,
  p_messages jsonb,
  p_last_modified text,
  p_last_name text
) returns integer
language sql
security definer
set search_path = ''
as $$
  select internal.enqueue_page(p_source, p_messages, p_last_modified, p_last_name);
$$;

-- The cursor as the fixed-width text ERPNext uses, so the TypeScript side never parses a timestamp.
create or replace function public.read_sync_cursor(p_source text, p_stream text)
returns table (modified text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select to_char(c.cursor_modified, 'YYYY-MM-DD HH24:MI:SS.US'), c.cursor_name
  from internal.sync_cursor c
  where c.source = p_source and c.stream = p_stream;
$$;

-- Closes runs left 'running' by a killed function (the wall clock is 150 s, so 10 minutes is
-- unambiguous), then opens a new one.
create or replace function public.start_sync_run(p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.sync_run
  set status = 'failed',
      finished_at = now(),
      error = coalesce(error, 'abandoned: still running after 10 minutes')
  where source = p_source
    and status = 'running'
    and started_at < now() - interval '10 minutes';

  insert into public.sync_run (source) values (p_source) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finish_sync_run(
  p_id uuid,
  p_status text,
  p_pages integer,
  p_fetched integer,
  p_enqueued integer,
  p_error text,
  p_fetched_docs jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'incomplete', 'failed') then
    raise exception 'finish_sync_run: invalid status %', p_status;
  end if;

  update public.sync_run
  set status = p_status,
      finished_at = now(),
      pages = p_pages,
      fetched_count = p_fetched,
      enqueued = p_enqueued,
      error = p_error,
      fetched = coalesce(p_fetched_docs, '[]'::jsonb)
  where id = p_id and status = 'running';

  if not found then
    raise exception 'finish_sync_run: no running sync_run %', p_id;
  end if;
end;
$$;

-- Status of the latest finished run of a source (null if none), so a run can resume after an
-- 'incomplete' one.
create or replace function public.last_sync_run_status(p_source text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.status
  from public.sync_run r
  where r.source = p_source and r.status <> 'running'
  order by r.started_at desc
  limit 1;
$$;

revoke all on function public.enqueue_page(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.read_sync_cursor(text, text) from public, anon, authenticated;
revoke all on function public.start_sync_run(text) from public, anon, authenticated;
revoke all on function public.finish_sync_run(uuid, text, integer, integer, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.last_sync_run_status(text) from public, anon, authenticated;

grant execute on function public.enqueue_page(text, jsonb, text, text) to service_role;
grant execute on function public.read_sync_cursor(text, text) to service_role;
grant execute on function public.start_sync_run(text) to service_role;
grant execute on function public.finish_sync_run(uuid, text, integer, integer, integer, text, jsonb) to service_role;
grant execute on function public.last_sync_run_status(text) to service_role;

-- ---------------------------------------------------------------- raw payloads

-- Private bucket for the raw JSON of every document version (PLAN "What travels on each arrow").
insert into storage.buckets (id, name, public)
values ('raw', 'raw', false)
on conflict (id) do nothing;
