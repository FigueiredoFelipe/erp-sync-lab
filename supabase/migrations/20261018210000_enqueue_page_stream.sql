-- T14: each Source A stream has its own forward-only cursor (PLAN "Source A: incremental fetch").
-- enqueue_page gains p_stream ('invoices' | 'deleted'); the old 4-argument signature stays and delegates
-- with 'invoices', so callers that don't know about streams keep working.
-- The 'deleted' stream's cursor is (creation, name) of Frappe's Deleted Document; its messages are
-- tombstones with version "3|<creation>", which outranks any "1|" or "2|" version of the same invoice.

-- ---------------------------------------------------------------- internal

create or replace function internal.enqueue_page(
  p_source text,
  p_stream text,
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
  if p_stream is null or p_stream not in ('invoices', 'deleted') then
    raise exception 'enqueue_page: unknown stream %', p_stream;
  end if;
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
    -- One message per key: the highest version in the page.
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

  -- Forward only, per stream: a page re-read inside the overlap window never moves the cursor back.
  insert into internal.sync_cursor as sc (source, stream, cursor_modified, cursor_name, updated_at)
  values (p_source, p_stream, p_last_modified::timestamp(6), p_last_name, now())
  on conflict (source, stream) do update
    set cursor_modified = excluded.cursor_modified,
        cursor_name = excluded.cursor_name,
        updated_at = excluded.updated_at
    where (excluded.cursor_modified, excluded.cursor_name collate "C")
        > (sc.cursor_modified, sc.cursor_name collate "C");

  return cardinality(v_payloads);
end;
$$;

-- The T6 signature, kept for compatibility: the invoices stream.
create or replace function internal.enqueue_page(
  p_source text,
  p_messages jsonb,
  p_last_modified text,
  p_last_name text
) returns integer
language sql
security definer
set search_path = ''
as $$
  select internal.enqueue_page(p_source, 'invoices', p_messages, p_last_modified, p_last_name);
$$;

revoke all on function internal.enqueue_page(text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function internal.enqueue_page(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function internal.enqueue_page(text, text, jsonb, text, text) to service_role;
grant execute on function internal.enqueue_page(text, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------- public wrappers (service_role only)

-- PostgREST picks the overload by the named arguments: {p_source, p_stream, p_messages, ...} reaches
-- this one, the T6 call without p_stream reaches the old one.
create or replace function public.enqueue_page(
  p_source text,
  p_stream text,
  p_messages jsonb,
  p_last_modified text,
  p_last_name text
) returns integer
language sql
security definer
set search_path = ''
as $$
  select internal.enqueue_page(p_source, p_stream, p_messages, p_last_modified, p_last_name);
$$;

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
  select internal.enqueue_page(p_source, 'invoices', p_messages, p_last_modified, p_last_name);
$$;

revoke all on function public.enqueue_page(text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.enqueue_page(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.enqueue_page(text, text, jsonb, text, text) to service_role;
grant execute on function public.enqueue_page(text, jsonb, text, text) to service_role;
