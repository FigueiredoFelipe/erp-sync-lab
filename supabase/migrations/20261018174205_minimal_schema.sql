-- Minimal schema (PLAN "Data model", "Queue, consumers and failures", "Dashboard, API and access").
-- public: read by the dashboard through RLS (no policies yet, so only service_role reads).
-- internal: control state, never exposed through the API.

-- Default privileges first, so nothing created below inherits Supabase's grants to the API roles.
-- Per-schema defaults can only add to the global ones, so EXECUTE for PUBLIC is revoked globally.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;
grant usage on schema internal to service_role;

alter default privileges for role postgres in schema internal revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema internal revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema internal revoke all on functions from public, anon, authenticated;
alter default privileges for role postgres in schema internal grant all on tables to service_role;
alter default privileges for role postgres in schema internal grant all on sequences to service_role;
alter default privileges for role postgres in schema internal grant execute on functions to service_role;

-- Queues: durable (logged), touched only by services with the service role.
create extension if not exists pgmq;
select pgmq.create('invoice_events');
select pgmq.create('invoice_events_dlq');

-- ---------------------------------------------------------------- public

create table public.customer (
  canonical_id text primary key,
  display_name text not null
);

create table public.invoice (
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  source_doc_id text not null,
  source_customer text not null,
  -- Nullable until the customer mapping lands (ANALYSIS "Decisões", T7a/BR05 deviation).
  -- No FK: the mapping replaces customer as a whole, and revalidation follows it.
  canonical_customer_id text,
  invoice_date date not null,
  currency text not null,
  amount numeric(14, 2) not null,
  is_credit_note boolean not null default false,
  source_version text not null,
  mapping_version integer not null,
  candidate jsonb not null,
  raw_ref text not null,
  updated_at timestamptz not null default now(),
  primary key (source, source_doc_id)
);

-- Replaced as a set on every apply.
create table public.invoice_line (
  source text not null,
  source_doc_id text not null,
  line_no integer not null,
  item_code text,
  description text,
  qty numeric not null,
  unit_price numeric(14, 2) not null,
  net_amount numeric(14, 2) not null,
  primary key (source, source_doc_id, line_no),
  foreign key (source, source_doc_id) references public.invoice (source, source_doc_id) on delete cascade
);

-- Same key as invoice: a record is in one table or the other, never both.
create table public.quarantine (
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  source_doc_id text not null,
  reason_code text not null check (reason_code in (
    'MISSING_FIELD', 'INVALID_DATE', 'UNSUPPORTED_CURRENCY', 'CONFLICTING_DUPLICATE',
    'TOTAL_MISMATCH', 'UNKNOWN_CUSTOMER', 'PROCESSING_FAILED'
  )),
  detail text,
  source_customer text,
  candidate jsonb,
  raw_ref text,
  source_version text not null,
  mapping_version integer,
  first_rejected_at timestamptz not null default now(),
  last_rejected_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolution text check (resolution in ('valid', 'cancelled', 'removed_from_export')),
  primary key (source, source_doc_id),
  check ((status = 'open') = (resolved_at is null and resolution is null))
);

-- One row per producer run; `fetched` is the run log (name + version per document, AC02).
create table public.sync_run (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'incomplete', 'failed')),
  fetched jsonb not null default '[]'::jsonb,
  pages integer not null default 0,
  fetched_count integer not null default 0,
  enqueued integer not null default 0,
  error text,
  check ((status = 'running') = (finished_at is null))
);

-- Key fields are nullable: a message too malformed to carry a key still lands here.
create table public.dead_letter (
  msg_id bigint primary key,
  source text check (source in ('erpnext', 'legacy_unit_b')),
  source_doc_id text,
  source_version text,
  last_error text,
  attempts integer not null,
  payload jsonb not null,
  moved_at timestamptz not null default now()
);

create table public.consumer_heartbeat (
  id boolean primary key default true check (id),
  last_run_at timestamptz,
  processed integer not null default 0,
  oldest_message_age interval
);
insert into public.consumer_heartbeat (id) values (true);

-- ---------------------------------------------------------------- internal

-- applied_version is the atomic guard; enqueued_version stops re-enqueuing the same version.
create table internal.record_version (
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  source_doc_id text not null,
  applied_version text,
  enqueued_version text,
  primary key (source, source_doc_id)
);

-- Source A: ERPNext customer ID. Source B: normalized name.
create table internal.customer_alias (
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  match_key text not null,
  canonical_id text not null references public.customer (canonical_id),
  primary key (source, match_key)
);

-- 0 means no mapping applied yet.
create table internal.mapping_state (
  id boolean primary key default true check (id),
  mapping_version integer not null default 0
);
insert into internal.mapping_state (id) values (true);

-- invoices: (modified, name) of Sales Invoice. deleted: (creation, name) of Deleted Document.
-- timestamp without time zone: ERPNext returns naive local time (America/New_York).
create table internal.sync_cursor (
  source text not null check (source in ('erpnext', 'legacy_unit_b')),
  stream text not null check (stream in ('invoices', 'deleted')),
  cursor_modified timestamp(6) not null,
  cursor_name text not null,
  updated_at timestamptz not null default now(),
  primary key (source, stream)
);

-- Attempts actually started per message; pgmq's read_ct also counts batch-mates of a crashed run.
create table internal.message_attempt (
  msg_id bigint primary key,
  attempts integer not null default 0,
  last_attempt_at timestamptz
);

-- Who may see data (R11).
create table internal.allowlist (
  email text primary key check (email = lower(email))
);

-- Fault injection for AC03; read only when ENABLE_TEST_SWITCHES is set.
create table internal.test_switch (
  name text primary key,
  enabled boolean not null default false,
  value jsonb
);

-- ---------------------------------------------------------------- access

-- RLS on with no policies: anon and authenticated get no rows until the allowlist policy lands.
alter table public.customer enable row level security;
alter table public.invoice enable row level security;
alter table public.invoice_line enable row level security;
alter table public.quarantine enable row level security;
alter table public.sync_run enable row level security;
alter table public.dead_letter enable row level security;
alter table public.consumer_heartbeat enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

revoke all on all tables in schema internal from public, anon, authenticated;
revoke execute on all functions in schema internal from public, anon, authenticated;
grant all on all tables in schema internal to service_role;

-- pgmq: no API role reaches the schema, its queue tables or its functions.
revoke all on schema pgmq from public, anon, authenticated;
revoke all on all tables in schema pgmq from public, anon, authenticated;
revoke all on all sequences in schema pgmq from public, anon, authenticated;
revoke execute on all functions in schema pgmq from public, anon, authenticated;
alter default privileges for role postgres in schema pgmq revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema pgmq revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema pgmq revoke all on functions from public, anon, authenticated;
