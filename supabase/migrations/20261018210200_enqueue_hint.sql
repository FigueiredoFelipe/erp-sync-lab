-- T21: the webhook queues a hint (PLAN "Source A: webhooks (P2)"; R02, AC09).
-- A hint carries only the invoice name; it has no version, so it skips record_version: the consumer
-- fetches the current document and applies it through the usual version guard.

create or replace function public.enqueue_hint(p_message jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object'
     or p_message ->> 'kind' is distinct from 'hint'
     or p_message ->> 'source' is distinct from 'erpnext'
     or (p_message -> 'v') is distinct from '1'::jsonb then
    raise exception 'enqueue_hint: expected {v: 1, kind: "hint", source: "erpnext", sourceDocId}';
  end if;
  v_name := p_message ->> 'sourceDocId';
  if coalesce(btrim(v_name), '') = '' or length(v_name) > 140 then
    raise exception 'enqueue_hint: sourceDocId must be a non-empty name of at most 140 characters';
  end if;
  -- Only the four known keys travel, whatever else the caller put in the object.
  return (
    select s from pgmq.send('invoice_events', jsonb_build_object('v', 1, 'kind', 'hint', 'source', 'erpnext', 'sourceDocId', v_name)) as s
  );
end;
$$;

revoke all on function public.enqueue_hint(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_hint(jsonb) to service_role;
