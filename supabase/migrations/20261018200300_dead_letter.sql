-- T13: dead-letter queue and PROCESSING_FAILED (SPEC R13, AC13; PLAN "Queue, consumers and failures").
-- internal.dead_letter moves a message that failed 5 attempts (Q4) out of the main queue, in one transaction:
--   1. sends its payload to invoice_events_dlq and records a public.dead_letter row;
--   2. deletes it from invoice_events (and its attempt counter);
--   3. if the record's key has a row in public.invoice that the failed message could have changed (its version
--      is unknown, or not older than the stored one), that row leaves the figures and the key is quarantined
--      as PROCESSING_FAILED (principle 1: we can't vouch for a number we couldn't reprocess).
-- A message too malformed to carry a key only goes to the DLQ.
-- The heartbeat's `parked` column now means: messages this run moved to the DLQ.

create or replace function internal.dead_letter(p_msg_id bigint, p_error text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_read_ct integer;
  v_attempts integer;
  v_source text;
  v_doc_id text;
  v_version text;
  v_inv_version text;
  v_inv_customer text;
  v_inv_candidate jsonb;
  v_inv_raw_ref text;
  v_inv_mapping integer;
begin
  -- Locks the message row, so two runs can't move it twice.
  select message, read_ct into v_payload, v_read_ct from pgmq.q_invoice_events where msg_id = p_msg_id for update;
  if not found then
    -- Already applied or moved by another run.
    delete from internal.message_attempt where msg_id = p_msg_id;
    return 'missing';
  end if;

  -- The key, only when the message is well formed enough to carry one.
  if jsonb_typeof(v_payload) = 'object'
     and v_payload ->> 'source' in ('erpnext', 'legacy_unit_b')
     and jsonb_typeof(v_payload -> 'sourceDocId') = 'string'
     and v_payload ->> 'sourceDocId' <> '' then
    v_source := v_payload ->> 'source';
    v_doc_id := v_payload ->> 'sourceDocId';
    if jsonb_typeof(v_payload -> 'sourceVersion') = 'string' then
      v_version := v_payload ->> 'sourceVersion';
    end if;
  end if;

  select attempts into v_attempts from internal.message_attempt where msg_id = p_msg_id;

  perform pgmq.send('invoice_events_dlq', v_payload);
  insert into public.dead_letter (msg_id, source, source_doc_id, source_version, last_error, attempts, payload, moved_at)
  values (p_msg_id, v_source, v_doc_id, v_version, p_error, coalesce(v_attempts, v_read_ct, 0), v_payload, now())
  on conflict (msg_id) do nothing;
  perform pgmq.delete('invoice_events', p_msg_id);
  delete from internal.message_attempt where msg_id = p_msg_id;

  if v_doc_id is null then
    return 'moved';
  end if;

  -- R13: an older valid version in the figures leaves them. A message older than the stored version
  -- couldn't have changed it (it would have been stale), so that one stays.
  delete from public.invoice
  where source = v_source and source_doc_id = v_doc_id
    and (v_version is null or v_version collate "C" >= source_version collate "C")
  returning source_version, source_customer, candidate, raw_ref, mapping_version
  into v_inv_version, v_inv_customer, v_inv_candidate, v_inv_raw_ref, v_inv_mapping;

  if v_inv_version is not null then
    insert into public.quarantine as q (
      source, source_doc_id, reason_code, detail, source_customer, candidate, raw_ref, source_version,
      mapping_version, first_rejected_at, last_rejected_at, status, resolved_at, resolution
    ) values (
      v_source, v_doc_id, 'PROCESSING_FAILED',
      format('Message %s (version %s) failed %s attempts: %s', p_msg_id, coalesce(v_version, 'unknown'),
             coalesce(v_attempts, v_read_ct, 0), coalesce(p_error, 'unknown error')),
      v_inv_customer, v_inv_candidate, v_inv_raw_ref, v_inv_version, v_inv_mapping, now(), now(), 'open', null, null
    )
    on conflict (source, source_doc_id) do update set
      reason_code = excluded.reason_code,
      detail = excluded.detail,
      source_customer = excluded.source_customer,
      candidate = excluded.candidate,
      raw_ref = excluded.raw_ref,
      source_version = excluded.source_version,
      mapping_version = excluded.mapping_version,
      first_rejected_at = case when q.status = 'resolved' then now() else q.first_rejected_at end,
      last_rejected_at = now(),
      status = 'open',
      resolved_at = null,
      resolution = null;
  end if;

  return 'moved';
end;
$$;

-- ---------------------------------------------------------------- public wrappers (service_role only)

create or replace function public.dead_letter_message(p_msg_id bigint, p_error text)
returns text
language sql
security definer
set search_path = ''
as $$ select internal.dead_letter(p_msg_id, p_error); $$;

drop function if exists public.write_consumer_heartbeat(integer, interval, integer);

-- parked = messages this run moved to the DLQ (0 when none).
create or replace function public.write_consumer_heartbeat(
  p_processed integer,
  p_oldest_message_age interval,
  p_dead_lettered integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.consumer_heartbeat
  set last_run_at = now(), processed = p_processed, oldest_message_age = p_oldest_message_age, parked = p_dead_lettered
  where id;
$$;

revoke execute on function
  internal.dead_letter(bigint, text),
  public.dead_letter_message(bigint, text),
  public.write_consumer_heartbeat(integer, interval, integer)
from public, anon, authenticated;

grant execute on function
  public.dead_letter_message(bigint, text),
  public.write_consumer_heartbeat(integer, interval, integer)
to service_role;
