-- T18: queue metrics for the sync health page (PLAN "Dashboard, API and access": oldest pending message,
-- DLQ size). pgmq is not exposed through the API, so the service reads it through a thin wrapper in
-- public: SECURITY DEFINER, empty search_path, EXECUTE only for service_role
-- (PLAN "Data model: How services reach internal").
create function public.app_queue_metrics()
returns table (queue_name text, queue_length bigint, oldest_msg_age_sec integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.queue_name::text, m.queue_length::bigint, m.oldest_msg_age_sec::integer
  from (values ('invoice_events'), ('invoice_events_dlq')) as q (name)
  cross join lateral pgmq.metrics(q.name) as m;
$$;

revoke execute on function public.app_queue_metrics() from public, anon, authenticated;
grant execute on function public.app_queue_metrics() to service_role;
