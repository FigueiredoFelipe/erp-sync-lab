-- T8: customer mapping (PLAN "Customer resolution", "Idempotency and versioning"; SPEC R05, BR05).
-- 1. internal.apply_customer_mapping(jsonb) replaces public.customer and internal.customer_alias and bumps
--    mapping_version, in the caller's transaction. Aliases are stored exactly as the mapping file writes them;
--    normalization (BR05) runs in one place only, TypeScript, when the consumer builds its lookup index.
-- 2. public.load_customer_index() gives the consumer the aliases and the mapping_version in one statement.
-- 3. apply_record refuses an outcome computed with another mapping_version (transient: the message is
--    retried with the new mapping) and stores the canonical customer of a valid invoice.

-- ---------------------------------------------------------------- apply_customer_mapping

-- p_mapping: [{ "canonical_id": "acme-foods", "display_name": "Acme Foods Inc.",
--               "erpnext": ["Acme Foods Inc."], "legacy_unit_b": ["ACME FOODS"] }, ...]
-- Returns the new mapping_version.
create or replace function internal.apply_customer_mapping(p_mapping jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_version integer;
  v_bad text;
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

  return v_version;
end;
$$;

-- ---------------------------------------------------------------- load_customer_index (service_role)

create or replace function public.load_customer_index()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'mappingVersion', (select mapping_version from internal.mapping_state),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'matchKey', match_key, 'canonicalId', canonical_id)
                       order by source, match_key)
      from internal.customer_alias
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------- apply_record

create or replace function internal.apply_record(p_outcome jsonb, p_msg_id bigint)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_kind text := p_outcome ->> 'kind';
  v_source text := p_outcome ->> 'source';
  v_doc_id text := p_outcome ->> 'sourceDocId';
  v_version text := p_outcome ->> 'sourceVersion';
  v_candidate jsonb := p_outcome -> 'candidate';
  v_outcome_mapping integer;
  v_canonical_id text := p_outcome ->> 'canonicalCustomerId';
  v_mapping_version integer;
  v_guard integer;
begin
  if v_kind is null or v_kind not in ('valid', 'invalid', 'cancelled') then
    raise exception 'apply_record: unknown outcome kind %', coalesce(v_kind, 'null') using errcode = '22023';
  end if;
  if v_source is null or v_doc_id is null or v_version is null or jsonb_typeof(v_candidate) is distinct from 'object' then
    raise exception 'apply_record: outcome without source, sourceDocId, sourceVersion or candidate' using errcode = '22023';
  end if;
  -- Only submitted (1) or cancelled (2) versions, fixed width, so byte order is version order.
  if v_version !~ '^[12]\|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$' then
    raise exception 'apply_record: invalid sourceVersion %', v_version using errcode = '22023';
  end if;
  -- The candidate must describe the same record and version as the outcome's key.
  if v_candidate ->> 'source' is distinct from v_source
     or v_candidate ->> 'sourceDocId' is distinct from v_doc_id
     or v_candidate ->> 'sourceVersion' is distinct from v_version then
    raise exception 'apply_record: candidate key or version differs from the outcome' using errcode = '22023';
  end if;
  if v_kind = 'invalid' and (p_outcome ->> 'reasonCode') is null then
    raise exception 'apply_record: invalid outcome without reasonCode' using errcode = '22023';
  end if;

  -- BR05: a verdict depends on the mapping it was computed with. The share lock keeps the mapping from
  -- changing until this transaction commits; an outcome from another mapping is refused, and the message
  -- is retried (with backoff) against the current one.
  select mapping_version into v_mapping_version from internal.mapping_state for share;
  if v_kind in ('valid', 'invalid') then
    if jsonb_typeof(p_outcome -> 'mappingVersion') is distinct from 'number' then
      raise exception 'apply_record: outcome without mappingVersion' using errcode = '22023';
    end if;
    v_outcome_mapping := (p_outcome ->> 'mappingVersion')::integer;
    if v_outcome_mapping <> v_mapping_version then
      raise exception 'apply_record: outcome computed with mapping_version %, current is %', v_outcome_mapping, v_mapping_version
        using errcode = '40001';
    end if;
  end if;
  if v_kind = 'valid' and (v_canonical_id is null
     or not exists (select 1 from public.customer where canonical_id = v_canonical_id)) then
    raise exception 'apply_record: valid outcome without a mapped canonicalCustomerId (%)', coalesce(v_canonical_id, 'null')
      using errcode = '22023';
  end if;

  -- Atomic version guard: one statement, so the row lock serializes concurrent applies of the same key.
  -- Byte order (COLLATE "C"), the same order enqueue_page and the TypeScript side use.
  insert into internal.record_version as rv (source, source_doc_id, applied_version)
  values (v_source, v_doc_id, v_version)
  on conflict (source, source_doc_id) do update set applied_version = excluded.applied_version
  where rv.applied_version is null
     or rv.applied_version collate "C" <= excluded.applied_version collate "C"
  returning 1 into v_guard;

  if v_guard is null then
    -- An older version than the one already applied: drop the message, change nothing.
    perform pgmq.delete('invoice_events', p_msg_id);
    delete from internal.message_attempt where msg_id = p_msg_id;
    return 'stale';
  end if;

  if v_kind = 'valid' then
    insert into public.invoice as i (
      source, source_doc_id, source_customer, canonical_customer_id, invoice_date, currency, amount,
      is_credit_note, source_version, mapping_version, candidate, raw_ref, updated_at
    ) values (
      v_source, v_doc_id, v_candidate ->> 'sourceCustomer', v_canonical_id, (v_candidate ->> 'invoiceDate')::date,
      v_candidate ->> 'currency', (v_candidate ->> 'netTotal')::numeric, (v_candidate ->> 'isCreditNote')::boolean,
      v_version, v_mapping_version, v_candidate, v_candidate ->> 'rawRef', now()
    )
    on conflict (source, source_doc_id) do update set
      source_customer = excluded.source_customer,
      canonical_customer_id = excluded.canonical_customer_id,
      invoice_date = excluded.invoice_date,
      currency = excluded.currency,
      amount = excluded.amount,
      is_credit_note = excluded.is_credit_note,
      source_version = excluded.source_version,
      mapping_version = excluded.mapping_version,
      candidate = excluded.candidate,
      raw_ref = excluded.raw_ref,
      updated_at = now();

    -- Lines are replaced as a set.
    delete from public.invoice_line where source = v_source and source_doc_id = v_doc_id;
    insert into public.invoice_line (source, source_doc_id, line_no, item_code, description, qty, unit_price, net_amount)
    select v_source, v_doc_id, (l ->> 'lineNo')::integer, l ->> 'itemCode', l ->> 'description',
           (l ->> 'qty')::numeric, (l ->> 'unitPrice')::numeric, (l ->> 'netAmount')::numeric
    from jsonb_array_elements(coalesce(v_candidate -> 'lines', '[]'::jsonb)) as l;

    update public.quarantine
    set status = 'resolved', resolved_at = now(), resolution = 'valid'
    where source = v_source and source_doc_id = v_doc_id and status = 'open';

  elsif v_kind = 'invalid' then
    insert into public.quarantine as q (
      source, source_doc_id, reason_code, detail, source_customer, candidate, raw_ref, source_version,
      mapping_version, first_rejected_at, last_rejected_at, status, resolved_at, resolution
    ) values (
      v_source, v_doc_id, p_outcome ->> 'reasonCode', p_outcome ->> 'detail', v_candidate ->> 'sourceCustomer',
      v_candidate, v_candidate ->> 'rawRef', v_version, v_mapping_version, now(), now(), 'open', null, null
    )
    on conflict (source, source_doc_id) do update set
      reason_code = excluded.reason_code,
      detail = excluded.detail,
      source_customer = excluded.source_customer,
      candidate = excluded.candidate,
      raw_ref = excluded.raw_ref,
      source_version = excluded.source_version,
      mapping_version = excluded.mapping_version,
      -- A resolved row that is rejected again starts a new episode.
      first_rejected_at = case when q.status = 'resolved' then now() else q.first_rejected_at end,
      last_rejected_at = now(),
      status = 'open',
      resolved_at = null,
      resolution = null;

    -- The previous valid version leaves the figures (R06, EC10). Lines cascade.
    delete from public.invoice where source = v_source and source_doc_id = v_doc_id;

  else -- cancelled (BR01)
    delete from public.invoice where source = v_source and source_doc_id = v_doc_id;
    update public.quarantine
    set status = 'resolved', resolved_at = now(), resolution = 'cancelled'
    where source = v_source and source_doc_id = v_doc_id and status = 'open';
  end if;

  -- Same transaction as the apply. Deleting nothing is fine: the guard already made the apply safe.
  perform pgmq.delete('invoice_events', p_msg_id);
  delete from internal.message_attempt where msg_id = p_msg_id;
  return v_kind;
end;
$$;

-- ---------------------------------------------------------------- grants

revoke execute on function
  internal.apply_customer_mapping(jsonb),
  internal.apply_record(jsonb, bigint),
  public.load_customer_index()
from public, anon, authenticated;

grant execute on function public.load_customer_index() to service_role;
