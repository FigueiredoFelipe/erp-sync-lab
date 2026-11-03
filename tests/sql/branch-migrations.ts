// Applies this track's migrations (versions 20261018200000..20261018200999) inside the caller's transaction,
// so SQL tests exercise the files in the branch and the rollback leaves the shared local db untouched.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

const DIR = join(__dirname, "..", "..", "supabase", "migrations");

const FILES = readdirSync(DIR)
  .filter((f) => /^20261018200\d{3}_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"));

export async function applyBranchMigrations(client: pg.Client): Promise<void> {
  for (const sql of FILES) await client.query(sql);
}

export async function currentMappingVersion(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ v: number }>("select mapping_version as v from internal.mapping_state");
  return rows[0]!.v;
}
