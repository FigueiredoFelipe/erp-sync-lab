-- T16: reconciliation of Source A (PLAN "Reconciliation"; R14, AC05).
-- reconcile-erpnext compares, document by document, ERPNext's submitted invoices with public.invoice and
-- classifies every difference. The classification is TypeScript (reconciliationService); SQL only reads a
-- consistent snapshot of the store and writes a run with its results in one transaction.

-- ---------------------------------------------------------------- tables (read by the health page)

create table if not exists public.reconciliation_run (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  erp_total numeric(14, 2),
  stored_total numeric(14, 2),
  unexplained integer,
  error text,
  check ((status = 'running') = (finished_at is null))
);

-- One row per document that differs, plus one 'summary' row per month (source_doc_id null).
create table if not exists public.reconciliation_result (
  run_id uuid not null references public.reconciliation_run (id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  source_doc_id text,
  erp_amount numeric(14, 2) not null,
  stored_amount numeric(14, 2) not null,
  class text not null check (class in ('in_flight', 'quarantined', 'dead_lettered', 'unexplained', 'summary')),
  check ((class = 'summary') = (source_doc_id is null)),
  unique nulls not distinct (run_id, month, source_doc_id)
);

create index if not exists reconciliation_run_started_at_idx on public.reconciliation_run (started_at desc);

alter table public.reconciliation_run enable row level security;
alter table public.reconciliation_result enable row level security;
revoke all on public.reconciliation_run from anon, authenticated;
revoke all on public.reconciliation_result from anon, authenticated;

-- ---------------------------------------------------------------- service wrappers (service_role only)

-- Closes runs left 'running' by a killed function (wall clock 150 s, so 10 minutes is unambiguous), then
-- opens a new one.
create or replace function public.start_reconciliation_run()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.reconciliation_run
  set status = 'failed',
      finished_at = now(),
      error = coalesce(error, 'abandoned: still running after 10 minutes')
  where status = 'running' and started_at < now() - interval '10 minutes';

  insert into public.reconciliation_run default values returning id into v_id;
  return v_id;
end;
$$;

-- Everything the classification needs, read in one statement so it is one consistent snapshot:
-- the invoices cursor, the stored Source A invoices dated in [p_from, p_to], the keys with a message
-- still in the queue (visible or not), open quarantine keys and dead-lettered keys.
create or replace function public.reconciliation_snapshot(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'cursor', (
      select jsonb_build_object('modified', to_char(c.cursor_modified, 'YYYY-MM-DD HH24:MI:SS.US'), 'name', c.cursor_name)
      from internal.sync_cursor c where c.source = 'erpnext' and c.stream = 'invoices'
    ),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', i.source_doc_id, 'amount', i.amount::text, 'invoiceDate', i.invoice_date::text) order by i.source_doc_id)
      from public.invoice i
      where i.source = 'erpnext' and i.invoice_date between p_from and p_to
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(distinct q.message ->> 'sourceDocId')
      from pgmq.q_invoice_events q
      where q.message ->> 'source' = 'erpnext' and q.message ->> 'sourceDocId' is not null
    ), '[]'::jsonb),
    'quarantined', coalesce((
      select jsonb_agg(qr.source_doc_id order by qr.source_doc_id)
      from public.quarantine qr where qr.source = 'erpnext' and qr.status = 'open'
    ), '[]'::jsonb),
    'deadLettered', coalesce((
      select jsonb_agg(distinct d.source_doc_id)
      from public.dead_letter d where d.source = 'erpnext' and d.source_doc_id is not null
    ), '[]'::jsonb)
  );
$$;

-- Closes a run with its totals and results in one transaction.
-- p_results: jsonb array of {month, sourceDocId, erpAmount, storedAmount, class}.
create or replace function public.finish_reconciliation_run(
  p_id uuid,
  p_status text,
  p_erp_total numeric,
  p_stored_total numeric,
  p_unexplained integer,
  p_error text,
  p_results jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'finish_reconciliation_run: invalid status %', p_status;
  end if;

  update public.reconciliation_run
  set status = p_status,
      finished_at = now(),
      erp_total = p_erp_total,
      stored_total = p_stored_total,
      unexplained = p_unexplained,
      error = p_error
  where id = p_id and status = 'running';
  if not found then
    raise exception 'finish_reconciliation_run: no running reconciliation_run %', p_id;
  end if;

  insert into public.reconciliation_result (run_id, month, source_doc_id, erp_amount, stored_amount, class)
  select p_id, r.month, r."sourceDocId", r."erpAmount", r."storedAmount", r.class
  from jsonb_to_recordset(coalesce(p_results, '[]'::jsonb))
    as r(month date, "sourceDocId" text, "erpAmount" numeric, "storedAmount" numeric, class text);
end;
$$;

revoke all on function public.start_reconciliation_run() from public, anon, authenticated;
revoke all on function public.reconciliation_snapshot(date, date) from public, anon, authenticated;
revoke all on function public.finish_reconciliation_run(uuid, text, numeric, numeric, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.start_reconciliation_run() to service_role;
grant execute on function public.reconciliation_snapshot(date, date) to service_role;
grant execute on function public.finish_reconciliation_run(uuid, text, numeric, numeric, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------- schedule (daily, Q6, + on demand)

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fires one reconciliation run; also the on-demand trigger: select internal.trigger_reconcile();
-- Vault secrets project_url, cron_secret and anon_key are set per database, never in the repository.
create or replace function internal.trigger_reconcile()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_cron_secret text;
  v_anon_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_cron_secret from vault.decrypted_secrets where name = 'cron_secret';
  select decrypted_secret into v_anon_key from vault.decrypted_secrets where name = 'anon_key';
  if v_url is null or v_cron_secret is null or v_anon_key is null then
    raise exception 'trigger_reconcile: Vault secrets project_url, cron_secret and anon_key must be set';
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/reconcile-erpnext',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_cron_secret,
      'Authorization', 'Bearer ' || v_anon_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end;
$$;

revoke all on function internal.trigger_reconcile() from public, anon, authenticated;
grant execute on function internal.trigger_reconcile() to service_role;

-- Daily at 06:00 UTC. Scheduling the same job name again replaces it.
select cron.schedule('reconcile-erpnext', '0 6 * * *', 'select internal.trigger_reconcile()');
