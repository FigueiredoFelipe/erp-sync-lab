-- T15: re-validate when the customer mapping changes (SPEC R15, EC09, AC15, AC16; PLAN "Customer resolution").
-- 1. apply_customer_mapping also enqueues a `revalidate` message, in the same transaction, for every open
--    UNKNOWN_CUSTOMER quarantine row and every stored invoice whose customer's aliases changed or disappeared.
-- 2. load_stored_record gives the consumer the candidate stored with the invoice or the open quarantine row,
--    so it re-validates without fetching from the source, at the same version. PROCESSING_FAILED rows are not
--    re-validated: their candidate is the old version that the failed message was replacing (R13).
-- 3. ack_invoice_event deletes a message that has nothing left to do (its record is gone).

create or replace function internal.apply_customer_mapping(p_mapping jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_version integer;
  v_bad text;
  v_old jsonb;
  v_messages jsonb[];
begin
  if jsonb_typeof(p_mapping) is distinct from 'array' then
    raise exception 'apply_customer_mapping: the mapping must be a JSON array' using errcode = '22023';
  end if;

  select e::text into v_bad
  from jsonb_array_elements(p_mapping) as e
  where jsonb_typeof(e) <> 'object'
     or coalesce(e ->> 'canonical_id', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or btrim(coalesce(e ->> 'display_name', '')) = ''
     or jsonb_typeof(coalesce(e -> 'erpnext', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(e -> 'legacy_unit_b', '[]'::jsonb)) <> 'array'
     or exists (
       select 1
       from jsonb_array_elements(coalesce(e -> 'erpnext', '[]'::jsonb) || coalesce(e -> 'legacy_unit_b', '[]'::jsonb)) as a
       where jsonb_typeof(a) <> 'string' or btrim(a #>> '{}') = ''
     )
  limit 1;
  if v_bad is not null then
    raise exception 'apply_customer_mapping: invalid entry %', v_bad using errcode = '22023';
  end if;

  -- Taking the row lock first: apply_record holds a share lock on this row while it applies, so the
  -- mapping waits for in-flight applies and blocks new ones until it commits.
  update internal.mapping_state set mapping_version = mapping_version + 1 where id returning mapping_version into v_version;

  -- The aliases before the change, to find the customers whose aliases changed or disappeared.
  select coalesce(jsonb_agg(jsonb_build_array(source, match_key, canonical_id)), '[]'::jsonb) into v_old
  from internal.customer_alias;

  delete from internal.customer_alias where true;
  delete from public.customer where true;

  -- A repeated canonical_id or alias violates the primary key and aborts the whole mapping.
  insert into public.customer (canonical_id, display_name)
  select e ->> 'canonical_id', btrim(e ->> 'display_name')
  from jsonb_array_elements(p_mapping) as e;

  insert into internal.customer_alias (source, match_key, canonical_id)
  select 'erpnext', a, e ->> 'canonical_id'
  from jsonb_array_elements(p_mapping) as e, jsonb_array_elements_text(coalesce(e -> 'erpnext', '[]'::jsonb)) as a
  union all
  select 'legacy_unit_b', a, e ->> 'canonical_id'
  from jsonb_array_elements(p_mapping) as e, jsonb_array_elements_text(coalesce(e -> 'legacy_unit_b', '[]'::jsonb)) as a;

  -- R15, EC09, AC15, AC16: re-validate, against the new mapping, every record whose verdict may change:
  --   - open UNKNOWN_CUSTOMER quarantine rows (a customer may now be listed);
  --   - stored invoices of a customer whose aliases changed (added, moved or removed) or who is gone,
  --     and invoices stored before any mapping (no canonical customer yet).
  -- Over-inclusive on purpose: re-validating an unchanged record at the same version changes nothing.
  with old_alias as (
    select e ->> 0 as source, e ->> 1 as match_key, e ->> 2 as canonical_id from jsonb_array_elements(v_old) as e
  ),
  new_alias as (
    select source, match_key, canonical_id from internal.customer_alias
  ),
  changed as (
    select canonical_id from (
      (select * from old_alias except select * from new_alias)
      union
      (select * from new_alias except select * from old_alias)
    ) as d
  ),
  targets as (
    select i.source, i.source_doc_id
    from public.invoice as i
    where i.canonical_customer_id is null
       or i.canonical_customer_id in (select canonical_id from changed)
       or not exists (select 1 from public.customer as c where c.canonical_id = i.canonical_customer_id)
    union
    select q.source, q.source_doc_id
    from public.quarantine as q
    where q.status = 'open' and q.reason_code = 'UNKNOWN_CUSTOMER'
  )
  select array_agg(jsonb_build_object('v', 1, 'kind', 'revalidate', 'source', source, 'sourceDocId', source_doc_id)
                   order by source, source_doc_id)
  into v_messages
  from targets;

  if v_messages is not null then
    perform pgmq.send_batch('invoice_events', v_messages);
  end if;

  return v_version;
end;
$$;

-- ---------------------------------------------------------------- load_stored_record

-- { location: invoice|quarantine, candidate } or null when there is nothing to re-validate.
create or replace function internal.load_stored_record(p_source text, p_source_doc_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('location', 'invoice', 'candidate', i.candidate)
     from public.invoice as i
     where i.source = p_source and i.source_doc_id = p_source_doc_id),
    (select jsonb_build_object('location', 'quarantine', 'candidate', q.candidate)
     from public.quarantine as q
     where q.source = p_source and q.source_doc_id = p_source_doc_id
       and q.status = 'open' and q.reason_code <> 'PROCESSING_FAILED' and q.candidate is not null)
  );
$$;

create or replace function internal.ack_invoice_event(p_msg_id bigint)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  v_deleted := pgmq.delete('invoice_events', p_msg_id);
  delete from internal.message_attempt where msg_id = p_msg_id;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------- public wrappers (service_role only)

create or replace function public.load_stored_record(p_source text, p_source_doc_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select internal.load_stored_record(p_source, p_source_doc_id); $$;

create or replace function public.ack_invoice_event(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$ select internal.ack_invoice_event(p_msg_id); $$;

revoke execute on function
  internal.apply_customer_mapping(jsonb),
  internal.load_stored_record(text, text),
  internal.ack_invoice_event(bigint),
  public.load_stored_record(text, text),
  public.ack_invoice_event(bigint)
from public, anon, authenticated;

grant execute on function
  public.load_stored_record(text, text),
  public.ack_invoice_event(bigint)
to service_role;
