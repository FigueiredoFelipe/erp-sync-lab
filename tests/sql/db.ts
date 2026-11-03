// Connection to the LOCAL Supabase stack for SQL integration tests (PLAN "Dependencies": pg, dev only).
// The default URL is the CLI's well-known local superuser, not a secret.
import pg from "pg";

const LOCAL_DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function localDbUrl(): string {
  return process.env["LOCAL_DB_URL"] ?? LOCAL_DEFAULT_URL;
}

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: localDbUrl() });
  await client.connect();
  return client;
}

// Runs `fn` inside a transaction that is always rolled back, so tests leave nothing behind.
export async function inRolledBackTx<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

// SQLSTATE of the error a statement raises, or null when it succeeds.
export async function sqlState(client: pg.Client, sql: string): Promise<string | null> {
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

export const INSUFFICIENT_PRIVILEGE = "42501";

// A Supabase Auth user for RLS tests: an auth.users row plus one auth.identities row, as GoTrue would
// write them after a sign-in. `identityEmail` is the email the provider asserted (identity_data), which
// can differ from the user-editable auth.users.email. Call inside a transaction that is rolled back.
export interface AuthUser {
  id: string;
  email: string;
  provider?: string;
  identityEmail?: string;
}

export async function createAuthUser(client: pg.Client, user: AuthUser): Promise<void> {
  const provider = user.provider ?? "google";
  const identityEmail = user.identityEmail ?? user.email;
  await client.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [
    user.id,
    user.email,
  ]);
  await client.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider)
     values ($1, $2, jsonb_build_object('sub', $1::text, 'email', $3::text, 'email_verified', true), $4)`,
    [`${provider}-${user.id}`, user.id, identityEmail, provider],
  );
}

// The JWT claims PostgREST would set for a signed-in user, for the rest of the transaction.
export async function setJwtClaims(client: pg.Client, claims: Record<string, unknown>): Promise<void> {
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}
