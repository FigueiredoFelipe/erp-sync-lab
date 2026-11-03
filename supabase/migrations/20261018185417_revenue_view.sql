-- T10: monthly revenue view and the test-switch lookup the dashboard services call
-- (PLAN "Revenue and trends", "Data model: How services reach internal", "Dashboard, API and access").

-- Monthly revenue reads only public.invoice (valid invoices), so a quarantined record can never be summed.
-- security_invoker: the view runs with the caller's privileges, so RLS on invoice still applies.
create view public.monthly_revenue
with (security_invoker = true) as
select
  date_trunc('month', invoice_date)::date as month,
  source,
  sum(amount)::numeric(14, 2) as revenue,
  count(*)::integer as invoices
from public.invoice
group by 1, 2;

revoke all on public.monthly_revenue from public, anon, authenticated;
grant select on public.monthly_revenue to service_role;

-- Fault injection for the dashboard (demo scene (b)). A switch is on when its row exists with enabled = true:
--   insert into internal.test_switch (name, enabled) values ('fail_freshness_api', true);
-- Deleting the row turns it off. Callers only consult it when ENABLE_TEST_SWITCHES=true.
-- Named app_test_switch to avoid colliding with the consumer's own wrapper.
create function public.app_test_switch(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select ts.enabled from internal.test_switch ts where ts.name = p_name), false);
$$;

revoke execute on function public.app_test_switch(text) from public, anon, authenticated;
grant execute on function public.app_test_switch(text) to service_role;
