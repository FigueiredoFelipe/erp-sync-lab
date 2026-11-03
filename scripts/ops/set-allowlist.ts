// Replaces internal.allowlist (T22, SPEC Q5) in one database with ALLOWLIST_EMAILS (comma-separated).
// Emails never go in a migration: the repository holds no personal data, so this runs once per database.
//
//   ALLOWLIST_EMAILS=a@example.com node --env-file=.env scripts/ops/set-allowlist.ts [database-url]
//
// The database URL is the first argument, or DATABASE_URL.
import pg from "pg";

const emails = (process.env["ALLOWLIST_EMAILS"] ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter((email) => email.length > 0);
if (emails.length === 0) throw new Error("Set ALLOWLIST_EMAILS to one or more comma-separated emails");

const dbUrl = process.argv[2] ?? process.env["DATABASE_URL"];
if (!dbUrl) throw new Error("Pass the database URL as the first argument or set DATABASE_URL");

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  await client.query("begin");
  await client.query("delete from internal.allowlist");
  await client.query("insert into internal.allowlist (email) select unnest($1::text[])", [emails]);
  await client.query("commit");
  console.log(`allowlist set: ${emails.length} email(s)`);
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
