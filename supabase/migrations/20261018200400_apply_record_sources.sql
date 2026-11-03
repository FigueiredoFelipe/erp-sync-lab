-- Tombstones and Source B records in apply_record (PLAN "Idempotency and versioning"; SPEC BR01, BR10, EC12, AC17).
-- 1. Versions per source: ERPNext "1|"/"2|"/"3|" + fixed-width timestamp ("3|" = Deleted Document, a tombstone
--    that outranks any submission or cancellation); Source B the file's export date "YYYY-MM-DD".
-- 2. New outcome `removed` (Source B tombstone): the invoice leaves the figures and an open quarantine row is
--    closed as removed_from_export. A tombstone outcome carries no candidate.
-- 3. A tombstone for a key with no invoice and no quarantine row (still in flight) is a successful no-op that
--    records its version, so the older record is refused as stale when it arrives.

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
  if v_kind is null or v_kind not in ('valid', 'invalid', 'cancelled', 'removed') then
    raise exception 'apply_record: unknown outcome kind %', coalesce(v_kind, 'null') using errcode = '22023';
  end if;
  if v_source is null or v_doc_id is null or v_version is null then
    raise exception 'apply_record: outcome without source, sourceDocId or sourceVersion' using errcode = '22023';
  end if;
  -- A tombstone (cancelled from ERPNext's Deleted Document, removed from a Source B export) carries no candidate.
  if jsonb_typeof(v_candidate) = 'null' then
    v_candidate := null;
  end if;
  if v_candidate is null and v_kind in ('valid', 'invalid') then
    raise exception 'apply_record: % outcome without candidate', v_kind using errcode = '22023';
  end if;
  if v_candidate is not null and jsonb_typeof(v_candidate) <> 'object' then
    raise exception 'apply_record: candidate is not an object' using errcode = '22023';
  end if;
  -- Fixed-width versions per source, so byte order is version order. Never a draft ("0|", BR01, AC06).
  --   erpnext:       "1|" submitted, "2|" cancelled, "3|" deleted (tombstone, cancelled outcome only) + modified
  --   legacy_unit_b: the export date of the file; removed (BR10) only for this source
  if v_source = 'erpnext' then
    if v_version !~ '^[123]\|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$' then
      raise exception 'apply_record: invalid sourceVersion %', v_version using errcode = '22023';
    end if;
    if v_version like '3|%' and (v_kind <> 'cancelled' or v_candidate is not null) then
      raise exception 'apply_record: a deleted-document version (3|) only cancels' using errcode = '22023';
    end if;
    if v_kind = 'removed' then
      raise exception 'apply_record: removed applies only to legacy_unit_b' using errcode = '22023';
    end if;
  elsif v_source = 'legacy_unit_b' then
    if v_version !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'apply_record: invalid sourceVersion %', v_version using errcode = '22023';
    end if;
    if v_kind = 'cancelled' then
      raise exception 'apply_record: cancelled applies only to erpnext' using errcode = '22023';
    end if;
  else
    raise exception 'apply_record: unknown source %', v_source using errcode = '22023';
  end if;
  -- The candidate must describe the same record and version as the outcome's key.
  if v_candidate is not null and (
       v_candidate ->> 'source' is distinct from v_source
       or v_candidate ->> 'sourceDocId' is distinct from v_doc_id
       or v_candidate ->> 'sourceVersion' is distinct from v_version) then
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

  -- A tombstone for a key still in flight (enqueued, never applied) has nothing to remove, but the guard
  -- above already recorded its version, so the older record arriving later is refused as stale.
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

  else -- cancelled (BR01, EC12) or removed (BR10): out of the figures, open quarantine closed
    delete from public.invoice where source = v_source and source_doc_id = v_doc_id;
    update public.quarantine
    set status = 'resolved', resolved_at = now(),
        resolution = case when v_kind = 'removed' then 'removed_from_export' else 'cancelled' end
    where source = v_source and source_doc_id = v_doc_id and status = 'open';
  end if;

  -- Same transaction as the apply. Deleting nothing is fine: the guard already made the apply safe.
  perform pgmq.delete('invoice_events', p_msg_id);
  delete from internal.message_attempt where msg_id = p_msg_id;
  return v_kind;
end;
$$;

revoke execute on function internal.apply_record(jsonb, bigint) from public, anon, authenticated;
