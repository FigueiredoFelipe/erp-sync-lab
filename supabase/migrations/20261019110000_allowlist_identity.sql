-- T22 review fix: match the allowlist against the Google identity, not the JWT's top-level email claim.
-- The top-level email is auth.users.email, which the user can change through PUT /auth/v1/user while
-- app_metadata.provider stays 'google'. auth.identities.identity_data carries the email Google asserted
-- at sign-in and is not editable by the user. The provider check stays as a second condition, so an
-- account first created with another provider and later linked to Google is still denied.
create or replace function internal.is_allowlisted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') = 'google'
     and exists (
       select 1
       from auth.identities i
       join internal.allowlist a on a.email = lower(i.identity_data ->> 'email')
       where i.user_id = auth.uid()
         and i.provider = 'google'
     );
$$;

revoke execute on function internal.is_allowlisted() from public, anon;
grant execute on function internal.is_allowlisted() to authenticated, service_role;
