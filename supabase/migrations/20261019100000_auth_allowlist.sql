-- T22: sign-in with Google and the allowlist (PLAN "Dashboard, API and access"; SPEC R11, AC10, Q5).
-- The database is the gate: the dashboard reads with the signed-in user's session, and every row in public
-- is visible only to an allowlisted Google account. Writes stay impossible for anon and authenticated.
-- The allowlist rows themselves are not in this migration (no personal emails in the repository):
-- scripts/ops/set-allowlist.ts writes them from ALLOWLIST_EMAILS.

-- ---------------------------------------------------------------- who is allowed

-- True when the caller's JWT is a Google sign-in whose email is on internal.allowlist.
-- SECURITY DEFINER so it can read internal.allowlist, which no API role can.
create or replace function internal.is_allowlisted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
     and exists (
       select 1 from internal.allowlist a
       where a.email = lower(coalesce(auth.jwt() ->> 'email', ''))
     );
$$;

-- RLS policies evaluate the function as the caller, so authenticated needs USAGE on internal and EXECUTE on
-- this one function. USAGE alone exposes nothing: no table in internal is granted, every other function in
-- internal stays revoked, and internal is not an exposed API schema, so this is not callable as an RPC.
grant usage on schema internal to authenticated;
revoke execute on function internal.is_allowlisted() from public, anon;
grant execute on function internal.is_allowlisted() to authenticated, service_role;

-- What the app asks to choose between the dashboard and the access-denied page. It only answers about
-- the caller; it is a boolean, never the list.
create or replace function public.app_access()
returns boolean
language sql
stable
set search_path = ''
as $$
  select internal.is_allowlisted();
$$;

revoke execute on function public.app_access() from public, anon;
grant execute on function public.app_access() to authenticated;

-- ---------------------------------------------------------------- tables: read-only, allowlist only

-- Every table in public: RLS on, a single SELECT policy for allowlisted users, SELECT granted to
-- authenticated, and nothing else. Looping keeps "every table" true for the tables later tasks added.
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
  loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('drop policy if exists allowlisted_read on public.%I', t.relname);
    execute format(
      'create policy allowlisted_read on public.%I for select to authenticated using ((select internal.is_allowlisted()))',
      t.relname
    );
    execute format('revoke all on public.%I from public, anon, authenticated', t.relname);
    execute format('grant select on public.%I to authenticated', t.relname);
  end loop;
end;
$$;

-- The views are security_invoker, so they inherit the policies of the tables above.
grant select on public.monthly_revenue, public.revenue_document, public.customer_monthly_revenue to authenticated;

-- ---------------------------------------------------------------- dashboard wrappers

-- The sync health page reads queue metrics and the demo's test switch through these SECURITY DEFINER
-- wrappers. They are read-only and now also granted to authenticated, so each one checks the allowlist
-- itself (a definer function bypasses the RLS above). service_role keeps calling them unchanged.
create or replace function public.app_queue_metrics()
returns table (queue_name text, queue_length bigint, oldest_msg_age_sec integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.queue_name::text, m.queue_length::bigint, m.oldest_msg_age_sec::integer
  from (values ('invoice_events'), ('invoice_events_dlq')) as q (name)
  cross join lateral pgmq.metrics(q.name) as m
  where current_setting('role', true) = 'service_role' or internal.is_allowlisted();
$$;

create or replace function public.app_test_switch(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (current_setting('role', true) = 'service_role' or internal.is_allowlisted())
     and coalesce((select ts.enabled from internal.test_switch ts where ts.name = p_name), false);
$$;

revoke execute on function public.app_queue_metrics(), public.app_test_switch(text) from public, anon;
grant execute on function public.app_queue_metrics(), public.app_test_switch(text) to authenticated, service_role;
