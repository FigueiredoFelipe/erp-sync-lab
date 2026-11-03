-- T17/T23: per-customer revenue and the documents behind each figure
-- (PLAN "Revenue and trends", "Dashboard, API and access"; SPEC R08, R12, BR07, AC12, AC18).
-- Both views read only public.invoice (valid invoices), so a quarantined record is never summed.
-- security_invoker: they run with the caller's privileges, so RLS on invoice and customer still applies.

-- One row per valid invoice, with the customer key the dashboard filters and drills down by:
-- the canonical customer when the mapping resolved it, otherwise "unmapped:<source>:<source_customer>",
-- labelled with the source's own customer name (canonical_customer_id is NULL until the mapping lands).
create view public.revenue_document
with (security_invoker = true) as
select
  i.source,
  i.source_doc_id,
  coalesce(i.canonical_customer_id, 'unmapped:' || i.source || ':' || i.source_customer) as customer_key,
  coalesce(c.display_name, i.canonical_customer_id, i.source_customer) as customer_name,
  i.canonical_customer_id is not null as mapped,
  i.source_customer,
  i.invoice_date,
  -- BR07: the month is the calendar month of the invoice date (credit notes included, in their own month).
  date_trunc('month', i.invoice_date)::date as month,
  i.currency,
  i.amount,
  i.is_credit_note,
  i.raw_ref,
  i.updated_at
from public.invoice i
left join public.customer c on c.canonical_id = i.canonical_customer_id;

-- BR07: monthly revenue per customer and source = sum of net totals, credit notes negative.
create view public.customer_monthly_revenue
with (security_invoker = true) as
select
  month,
  source,
  customer_key,
  customer_name,
  mapped,
  sum(amount)::numeric(14, 2) as revenue,
  count(*)::integer as invoices
from public.revenue_document
group by month, source, customer_key, customer_name, mapped;

revoke all on public.revenue_document, public.customer_monthly_revenue from public, anon, authenticated;
grant select on public.revenue_document, public.customer_monthly_revenue to service_role;
