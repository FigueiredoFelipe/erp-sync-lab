-- T9: queue consumer persistence (PLAN "Queue, consumers and failures", "Idempotency and versioning").
-- The verdict (valid, invalid, cancelled) is decided in TypeScript; SQL only does what must be atomic:
-- the version guard, applying the outcome and deleting the message in one transaction.
-- Logic lives in internal; services reach it through thin public wrappers (PLAN "How services reach internal").

-- ---------------------------------------------------------------- internal

-- Attempts actually started for a message. Runs as its own RPC call, so it commits on its own.
create or replace function internal.begin_attempt(p_msg_id bigint)
returns integer
language sql
set search_path = ''
as $$
  insert into internal.message_attempt as ma (msg_id, attempts, last_attempt_at)
  values (p_msg_id, 1, now())
  on conflict (msg_id) do update
    set attempts = ma.attempts + 1, last_attempt_at = now()
  returning attempts;
$$;

-- Applies one outcome and deletes its message, all in the caller's transaction.
-- p_outcome: { kind: valid|invalid|cancelled, source, sourceDocId, sourceVersion, reasonCode?, detail?, candidate }.
-- Returns the applied outcome, or 'stale' when a newer version was already applied.
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
  v_mapping_version integer;
  v_guard integer;
begin
  if v_kind is null or v_kind not in ('valid', 'invalid', 'cancelled') then
    raise exception 'apply_record: unknown outcome kind %', coalesce(v_kind, 'null') using errcode = '22023';
  end if;
  if v_source is null or v_doc_id is null or v_version is null or jsonb_typeof(v_candidate) is distinct from 'object' then
    raise exception 'apply_record: outcome without source, sourceDocId, sourceVersion or candidate' using errcode = '22023';
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

  -- Atomic version guard: one statement, so the row lock serializes concurrent applies of the same key.
  insert into internal.record_version as rv (source, source_doc_id, applied_version)
  values (v_source, v_doc_id, v_version)
  on conflict (source, source_doc_id) do update set applied_version = excluded.applied_version
  where rv.applied_version is null or rv.applied_version <= excluded.applied_version
  returning 1 into v_guard;

  if v_guard is null then
    -- An older version than the one already applied: drop the message, change nothing.
    perform pgmq.delete('invoice_events', p_msg_id);
    delete from internal.message_attempt where msg_id = p_msg_id;
    return 'stale';
  end if;

  select mapping_version into v_mapping_version from internal.mapping_state;

  if v_kind = 'valid' then
    -- BR05 deferred (ANALYSIS "Decisões"): canonical_customer_id stays null until T7/T8.
    insert into public.invoice as i (
      source, source_doc_id, source_customer, canonical_customer_id, invoice_date, currency, amount,
      is_credit_note, source_version, mapping_version, candidate, raw_ref, updated_at
    ) values (
      v_source, v_doc_id, v_candidate ->> 'sourceCustomer', null, (v_candidate ->> 'invoiceDate')::date,
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

-- ---------------------------------------------------------------- public wrappers (service_role only)

create or replace function public.read_invoice_events(p_vt integer, p_qty integer)
returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, message jsonb)
language sql
security definer
set search_path = ''
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.message from pgmq.read('invoice_events', p_vt, p_qty) as r;
$$;

create or replace function public.begin_attempt(p_msg_id bigint)
returns integer
language sql
security definer
set search_path = ''
as $$ select internal.begin_attempt(p_msg_id); $$;

create or replace function public.apply_record(p_outcome jsonb, p_msg_id bigint)
returns text
language sql
security definer
set search_path = ''
as $$ select internal.apply_record(p_outcome, p_msg_id); $$;

-- Backoff: hide the message for p_seconds from now.
create or replace function public.set_invoice_event_vt(p_msg_id bigint, p_seconds integer)
returns boolean
language sql
security definer
set search_path = ''
as $$ select exists (select 1 from pgmq.set_vt('invoice_events', p_msg_id, p_seconds)); $$;

create or replace function public.write_consumer_heartbeat(p_processed integer, p_oldest_message_age interval)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.consumer_heartbeat
  set last_run_at = now(), processed = p_processed, oldest_message_age = p_oldest_message_age
  where id;
$$;

-- AC03 fault injection; the caller only asks when ENABLE_TEST_SWITCHES is set.
create or replace function public.test_switch_enabled(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select coalesce((select enabled from internal.test_switch where name = p_name), false); $$;

revoke execute on function
  internal.begin_attempt(bigint),
  internal.apply_record(jsonb, bigint),
  public.read_invoice_events(integer, integer),
  public.begin_attempt(bigint),
  public.apply_record(jsonb, bigint),
  public.set_invoice_event_vt(bigint, integer),
  public.write_consumer_heartbeat(integer, interval),
  public.test_switch_enabled(text)
from public, anon, authenticated;

grant execute on function
  public.read_invoice_events(integer, integer),
  public.begin_attempt(bigint),
  public.apply_record(jsonb, bigint),
  public.set_invoice_event_vt(bigint, integer),
  public.write_consumer_heartbeat(integer, interval),
  public.test_switch_enabled(text)
to service_role;
