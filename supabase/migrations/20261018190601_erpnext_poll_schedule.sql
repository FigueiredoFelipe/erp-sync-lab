-- T6: schedule erpnext-poll every 5 minutes (Q3) through pg_cron + pg_net
-- (PLAN "Scheduling and runtime limits", "Queue, consumers and failures").
-- The Vault secrets project_url, cron_secret and anon_key are never created here (no secrets in the
-- repository): scripts/ops/set-vault-secrets.ts sets them per database.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fires one poll run and returns the pg_net request id. Also the on-demand trigger for the demo:
--   select internal.trigger_poll();
-- The HTTP call is asynchronous; correctness never depends on its response (the run records itself
-- in sync_run). The timeout covers the function's 150 s wall clock.
create or replace function internal.trigger_poll()
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
    raise exception 'trigger_poll: Vault secrets project_url, cron_secret and anon_key must be set';
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/erpnext-poll',
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

revoke all on function internal.trigger_poll() from public, anon, authenticated;
grant execute on function internal.trigger_poll() to service_role;

-- Scheduling the same job name again replaces it, so reapplying migrations restores the schedule.
select cron.schedule('erpnext-poll', '*/5 * * * *', 'select internal.trigger_poll()');
