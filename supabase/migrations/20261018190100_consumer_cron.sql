-- T9: schedule invoice-consumer every minute (PLAN "Scheduling and runtime limits").
-- Schedules live in migrations; cron.schedule with the same job name replaces the job, so reapplying is safe.
-- The project URL, cron secret and anon key come from Vault (never from the repository):
--   select vault.create_secret('<https://<ref>.supabase.co>', 'project_url');
--   select vault.create_secret('<cron secret>', 'cron_secret');
--   select vault.create_secret('<anon key>', 'anon_key');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fire-and-forget call through pg_net; correctness never depends on the HTTP response.
create or replace function internal.trigger_consumer()
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
    raise exception 'trigger_consumer: Vault secrets project_url, cron_secret and anon_key are required';
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/invoice-consumer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_anon_key,
      'x-cron-secret', v_cron_secret
    ),
    body := '{}'::jsonb,
    -- Above the 150 s wall-clock limit of the function.
    timeout_milliseconds := 170000
  );
end;
$$;

revoke execute on function internal.trigger_consumer() from public, anon, authenticated;

select cron.schedule('invoice-consumer', '* * * * *', 'select internal.trigger_consumer()');
