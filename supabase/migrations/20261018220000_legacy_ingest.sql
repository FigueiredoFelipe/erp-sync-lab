-- T12: Source B file ledger, upload bucket and register_file (PLAN "Source B: export file ingestion",
-- "How services reach internal"; R03, R10, BR10, EC06, EC07, AC14, AC17).
-- Re-runnable: the SQL tests apply this file inside a rolled-back transaction.

-- ---------------------------------------------------------------- public.source_file

-- One row per object of the legacy-uploads bucket that legacy-ingest has looked at.
create table if not exists public.source_file (
  object_name text primary key,
  exported_at date,                -- from the file name; null when the name carries no valid date
  uploaded_at timestamptz,         -- the object's creation time in Storage
  content_sha256 text,
  status text not null check (status in ('ingested', 'rejected')),
  reject_reason text,
  row_count integer,
  same_content_as text,            -- the newest ingested file this one repeats, if any (EC06)
  ingested_at timestamptz not null default now(),
  check ((status = 'rejected') = (reject_reason is not null)),
  check (status = 'rejected' or exported_at is not null)
);

alter table public.source_file enable row level security;
revoke all on table public.source_file from anon, authenticated;

-- ---------------------------------------------------------------- bucket

-- Private; the operator uploads with the service role and upsert: false. No storage.objects policy is
-- created, so anon and authenticated can't read, insert, update or delete in it; with no update policy an
-- uploaded file is never replaced through the API. 2 MiB comfortably holds 5,000 rows.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('legacy-uploads', 'legacy-uploads', false, 2097152, array['text/csv', 'text/plain', 'application/vnd.ms-excel'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------- internal.register_file

-- p_file: {objectName, exportedAt (YYYY-MM-DD or null), uploadedAt, contentSha256, rowCount, rejectReason}
-- p_records: jsonb array of Source B `record` messages, one per invoice (or "<object>#row<n>"), each with
--   sourceVersion = exportedAt. Ignored when the file is rejected or repeats the newest file.
--
-- In one transaction, in this order (PLAN steps 1-5):
--   0. an object already in source_file is a no-op (a retried or overlapping run): 'already_registered';
--   1. export date not after the newest ingested one (BR10): rejected 'older than <date>' (AC17);
--   2. rejectReason given (whole-file checks failed in TypeScript, EC07): rejected with that reason;
--   3. same SHA-256 as the newest ingested file: ingested with same_content_as, no message (EC06, AC14);
--   4. otherwise: ingested; sends every record, plus a tombstone for every Source B key that is in
--      invoice, in open quarantine, or still in flight (enqueued but not yet applied) and isn't in the file.
-- Returns {status, records, tombstones, reason?, sameContentAs?}.
create or replace function internal.register_file(p_file jsonb, p_records jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_object text := p_file ->> 'objectName';
  v_exported date;
  v_version text;
  v_sha text := nullif(p_file ->> 'contentSha256', '');
  v_uploaded timestamptz := (p_file ->> 'uploadedAt')::timestamptz;
  v_rows integer := (p_file ->> 'rowCount')::integer;
  v_reason text := nullif(p_file ->> 'rejectReason', '');
  v_newest record;
  v_records jsonb[];
  v_tombstones jsonb[];
begin
  if coalesce(v_object, '') = '' then
    raise exception 'register_file: objectName is required';
  end if;
  if nullif(p_file ->> 'exportedAt', '') is not null then
    v_exported := (p_file ->> 'exportedAt')::date;
    v_version := to_char(v_exported, 'YYYY-MM-DD');
  elsif v_reason is null then
    raise exception 'register_file: exportedAt is required unless the file is rejected';
  end if;

  -- One registration at a time: "newest file" and the tombstone set must not change under us.
  perform pg_advisory_xact_lock(hashtext('internal.register_file'));

  if exists (select 1 from public.source_file where object_name = v_object) then
    return jsonb_build_object('status', 'already_registered', 'records', 0, 'tombstones', 0);
  end if;

  select f.object_name, f.exported_at, f.content_sha256 into v_newest
  from public.source_file f
  where f.status = 'ingested'
  order by f.exported_at desc, f.ingested_at desc
  limit 1;

  -- 1. Older than (or as old as) the newest snapshot: a late file can't rewrite history.
  if v_exported is not null and v_newest.exported_at is not null and v_exported <= v_newest.exported_at then
    v_reason := 'older than ' || to_char(v_newest.exported_at, 'YYYY-MM-DD');
  end if;

  -- 1-2. Rejected whole: nothing from it is queued.
  if v_reason is not null then
    insert into public.source_file (object_name, exported_at, uploaded_at, content_sha256, status, reject_reason, row_count)
    values (v_object, v_exported, v_uploaded, v_sha, 'rejected', v_reason, v_rows);
    return jsonb_build_object('status', 'rejected', 'reason', v_reason, 'records', 0, 'tombstones', 0);
  end if;

  if v_sha is null then
    raise exception 'register_file: contentSha256 is required for an accepted file';
  end if;

  -- 3. Same content as the newest file: "nothing changed up to this date". Only the export date moves.
  if v_newest.object_name is not null and v_newest.content_sha256 = v_sha then
    insert into public.source_file (object_name, exported_at, uploaded_at, content_sha256, status, row_count, same_content_as)
    values (v_object, v_exported, v_uploaded, v_sha, 'ingested', v_rows, v_newest.object_name);
    return jsonb_build_object('status', 'ingested', 'sameContentAs', v_newest.object_name, 'records', 0, 'tombstones', 0);
  end if;

  -- 4. A new snapshot.
  if p_records is null or jsonb_typeof(p_records) <> 'array' or jsonb_array_length(p_records) = 0 then
    raise exception 'register_file: an accepted file needs a non-empty jsonb array of records';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_records) as m(msg)
    where m.msg ->> 'kind' is distinct from 'record'
       or m.msg ->> 'source' is distinct from 'legacy_unit_b'
       or m.msg ->> 'sourceVersion' is distinct from v_version
       or coalesce(m.msg ->> 'sourceDocId', '') = ''
  ) then
    raise exception 'register_file: every record needs kind record, source legacy_unit_b, sourceVersion % and a sourceDocId', v_version;
  end if;
  if (select count(distinct m.msg ->> 'sourceDocId') from jsonb_array_elements(p_records) as m(msg))
     <> jsonb_array_length(p_records) then
    raise exception 'register_file: duplicate sourceDocId in records';
  end if;

  select array_agg(m.msg order by m.ord) into v_records
  from jsonb_array_elements(p_records) with ordinality as m(msg, ord);

  -- BR10: every key that may count, may sit in quarantine, or may still land from an earlier file.
  with in_file as (
    select m.msg ->> 'sourceDocId' as doc_id from jsonb_array_elements(p_records) as m(msg)
  ),
  known as (
    select i.source_doc_id from public.invoice i where i.source = 'legacy_unit_b'
    union
    select q.source_doc_id from public.quarantine q where q.source = 'legacy_unit_b' and q.status = 'open'
    union
    select rv.source_doc_id from internal.record_version rv
    where rv.source = 'legacy_unit_b'
      and rv.enqueued_version is not null
      and (rv.applied_version is null or rv.applied_version collate "C" < rv.enqueued_version collate "C")
  )
  select array_agg(
    jsonb_build_object('v', 1, 'kind', 'tombstone', 'source', 'legacy_unit_b', 'sourceDocId', k.source_doc_id, 'sourceVersion', v_version)
    order by k.source_doc_id
  )
  into v_tombstones
  from known k
  where not exists (select 1 from in_file f where f.doc_id = k.source_doc_id);

  v_tombstones := coalesce(v_tombstones, '{}');

  perform pgmq.send_batch('invoice_events', v_records);
  if cardinality(v_tombstones) > 0 then
    perform pgmq.send_batch('invoice_events', v_tombstones);
  end if;

  -- Same bookkeeping as Source A: enqueued_version only moves forward.
  insert into internal.record_version as rv (source, source_doc_id, enqueued_version)
  select 'legacy_unit_b', m.msg ->> 'sourceDocId', v_version
  from unnest(v_records || v_tombstones) as m(msg)
  on conflict (source, source_doc_id) do update
    set enqueued_version = excluded.enqueued_version
    where rv.enqueued_version is null
       or rv.enqueued_version collate "C" < excluded.enqueued_version collate "C";

  insert into public.source_file (object_name, exported_at, uploaded_at, content_sha256, status, row_count)
  values (v_object, v_exported, v_uploaded, v_sha, 'ingested', v_rows);

  return jsonb_build_object('status', 'ingested', 'records', cardinality(v_records), 'tombstones', cardinality(v_tombstones));
end;
$$;

revoke all on function internal.register_file(jsonb, jsonb) from public, anon, authenticated;
grant execute on function internal.register_file(jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------- public wrappers (service_role only)

create or replace function public.register_file(p_file jsonb, p_records jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select internal.register_file(p_file, p_records);
$$;

-- Which of these object names legacy-ingest hasn't looked at yet.
create or replace function public.unregistered_files(p_names text[])
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select n.name
  from unnest(p_names) as n(name)
  where not exists (select 1 from public.source_file f where f.object_name = n.name);
$$;

revoke all on function public.register_file(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.unregistered_files(text[]) from public, anon, authenticated;
grant execute on function public.register_file(jsonb, jsonb) to service_role;
grant execute on function public.unregistered_files(text[]) to service_role;
