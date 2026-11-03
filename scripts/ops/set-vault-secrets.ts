// Upserts the Vault secrets internal.trigger_poll reads (project_url, cron_secret, anon_key) into one
// database. Secrets never go in a migration (constitution, principle 5), so this runs once per database.
// Prints secret names only, never values.
//
//   VAULT_PROJECT_URL=... VAULT_ANON_KEY=... node --env-file=.env scripts/ops/set-vault-secrets.ts <database-url>
//
// Sources, in order: VAULT_PROJECT_URL or SUPABASE_URL; CRON_SECRET; VAULT_ANON_KEY or SUPABASE_ANON_KEY.
// The database URL is the first argument, or DATABASE_URL. For the local stack, project_url must be
// reachable from inside the db container (e.g. http://kong:8000), not 127.0.0.1.
import pg from "pg";

const secrets: [name: string, value: string | undefined][] = [
  ["project_url", process.env["VAULT_PROJECT_URL"] ?? process.env["SUPABASE_URL"]],
  ["cron_secret", process.env["CRON_SECRET"]],
  ["anon_key", process.env["VAULT_ANON_KEY"] ?? process.env["SUPABASE_ANON_KEY"]],
];

const dbUrl = process.argv[2] ?? process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("Pass the database URL as the first argument or set DATABASE_URL");
const missing = secrets.filter(([, value]) => !value).map(([name]) => name);
if (missing.length > 0) throw new Error(`No value for: ${missing.join(", ")}`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  for (const [name, value] of secrets) {
    const { rows } = await client.query<{ id: string }>("select id from vault.secrets where name = $1", [name]);
    if (rows[0]) await client.query("select vault.update_secret($1, $2)", [rows[0].id, value]);
    else await client.query("select vault.create_secret($1, $2)", [value, name]);
    console.log(`${rows[0] ? "updated" : "created"} ${name}`);
  }
} finally {
  await client.end();
}
