// Reads the shipped customer mapping (the JSON inside the latest *_customer_mapping.sql migration), so pure
// tests can check its content against the seed and the Unit B README without a database.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomerAlias } from "../../src/core/customers/resolve.ts";

export type MappingEntry = { canonical_id: string; display_name: string; erpnext: string[]; legacy_unit_b: string[] };

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

export function latestMappingFile(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_customer_mapping\.sql$/.test(f)).sort();
  const latest = files.at(-1);
  if (!latest) throw new Error("no *_customer_mapping.sql migration");
  return join(MIGRATIONS_DIR, latest);
}

export function shippedMapping(): MappingEntry[] {
  const sql = readFileSync(latestMappingFile(), "utf8");
  const match = /\$mapping\$([\s\S]*?)\$mapping\$/.exec(sql);
  if (!match) throw new Error("mapping JSON not found between $mapping$ quotes");
  return JSON.parse(match[1]!) as MappingEntry[];
}

export function aliasesOf(mapping: MappingEntry[]): CustomerAlias[] {
  return mapping.flatMap((entry) => [
    ...entry.erpnext.map((matchKey) => ({ source: "erpnext" as const, matchKey, canonicalId: entry.canonical_id })),
    ...entry.legacy_unit_b.map((matchKey) => ({ source: "legacy_unit_b" as const, matchKey, canonicalId: entry.canonical_id })),
  ]);
}
