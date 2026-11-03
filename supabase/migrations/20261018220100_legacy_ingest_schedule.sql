-- T12: schedule legacy-ingest every 5 minutes (R03) through pg_cron + pg_net
-- (PLAN "Scheduling and runtime limits"). Same Vault secrets as trigger_poll: project_url, cron_secret and
-- anon_key, set per database by scripts/ops/set-vault-secrets.ts, never in the repository.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fires one ingest run (at most one file) and returns the pg_net request id. On demand:
--   select internal.trigger_legacy_ingest();
-- The run records itself in sync_run and source_file; correctness never depends on the HTTP response.
create or replace function internal.trigger_legacy_ingest()
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
    raise exception 'trigger_legacy_ingest: Vault secrets project_url, cron_secret and anon_key must be set';
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/legacy-ingest',
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

revoke all on function internal.trigger_legacy_ingest() from public, anon, authenticated;
grant execute on function internal.trigger_legacy_ingest() to service_role;

-- Scheduling the same job name again replaces it, so reapplying migrations restores the schedule.
select cron.schedule('legacy-ingest', '*/5 * * * *', 'select internal.trigger_legacy_ingest()');
