import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect } from "./db.ts";

// T2: the minimal migration created the tables, the queues and RLS (PLAN "Data model").
const PUBLIC_TABLES = [
  "consumer_heartbeat",
  "customer",
  "dead_letter",
  "invoice",
  "invoice_line",
  "quarantine",
  "reconciliation_result",
  "reconciliation_run",
  "source_file",
  "sync_run",
];
const INTERNAL_TABLES = [
  "allowlist",
  "customer_alias",
  "mapping_state",
  "message_attempt",
  "record_version",
  "sync_cursor",
  "test_switch",
];

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

async function tablesIn(schema: string): Promise<string[]> {
  const { rows } = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = $1 order by tablename",
    [schema],
  );
  return rows.map((row) => row.tablename);
}

describe("minimal schema", () => {
  it("creates the public tables", async () => {
    expect(await tablesIn("public")).toEqual(PUBLIC_TABLES);
  });

  it("creates the internal tables", async () => {
    expect(await tablesIn("internal")).toEqual(INTERNAL_TABLES);
  });

  it("creates both queues as logged queues", async () => {
    const { rows } = await client.query<{ queue_name: string; is_unlogged: boolean }>(
      "select queue_name, is_unlogged from pgmq.meta order by queue_name",
    );
    expect(rows).toEqual([
      { queue_name: "invoice_events", is_unlogged: false },
      { queue_name: "invoice_events_dlq", is_unlogged: false },
    ]);
  });

  it("enables RLS on every public table", async () => {
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("enables RLS with no policies on every internal table", async () => {
    const { rows: withoutRls } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c
       where c.relnamespace = 'internal'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    );
    expect(withoutRls).toEqual([]);
    const { rows: policies } = await client.query(`select policyname from pg_policies where schemaname = 'internal'`);
    expect(policies).toEqual([]);
  });

  it("lets service_role read internal tables despite RLS", async () => {
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      const { rows } = await client.query<{ mapping_version: number }>("select mapping_version from internal.mapping_state");
      expect(rows).toHaveLength(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps internal and pgmq out of the API's exposed schemas", () => {
    const config = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
    const api = config.slice(config.indexOf("[api]"), config.indexOf("\n[", config.indexOf("[api]") + 1));
    const schemas = /^schemas\s*=\s*\[(.*)\]/m.exec(api)?.[1] ?? "";
    expect(schemas).toContain('"public"');
    expect(schemas).not.toContain("internal");
    expect(schemas).not.toContain("pgmq");
  });
});
