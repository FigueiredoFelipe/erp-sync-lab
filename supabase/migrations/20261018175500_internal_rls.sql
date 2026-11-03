-- Defense in depth: internal is not exposed through the API and anon/authenticated have no
-- privileges on it, but RLS with no policies also denies every row to any role that doesn't bypass RLS.
-- postgres (owner, used by SECURITY DEFINER functions) and service_role bypass RLS, so they keep working.
alter table internal.record_version enable row level security;
alter table internal.customer_alias enable row level security;
alter table internal.mapping_state enable row level security;
alter table internal.sync_cursor enable row level security;
alter table internal.message_attempt enable row level security;
alter table internal.allowlist enable row level security;
alter table internal.test_switch enable row level security;
