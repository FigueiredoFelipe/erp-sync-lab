import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T21: public.enqueue_hint (LOCAL db), applied inside a rolled-back transaction.
const MIGRATION = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261018210200_enqueue_hint.sql"), "utf8");
const NAME = "T21-TEST-0001";

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await client.query(MIGRATION);
});

afterEach(async () => {
  await client.query("rollback");
});

const hint = (extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: "hint", source: "erpnext", sourceDocId: NAME, ...extra });

describe("public.enqueue_hint", () => {
  it("sends exactly the hint contract to invoice_events and returns its msg id", async () => {
    const { rows } = await client.query<{ id: string }>("select public.enqueue_hint($1::jsonb) as id", [hint({ extra: "dropped" })]);
    const queued = await client.query("select msg_id::text, message from pgmq.q_invoice_events where message->>'sourceDocId' = $1", [NAME]);
    expect(queued.rows).toEqual([{ msg_id: rows[0]!.id, message: { v: 1, kind: "hint", source: "erpnext", sourceDocId: NAME } }]);
    const versions = await client.query("select 1 from internal.record_version where source_doc_id = $1", [NAME]);
    expect(versions.rows).toHaveLength(0);
  });

  it.each([
    ["another kind", { kind: "record" }],
    ["another source", { source: "legacy_unit_b" }],
    ["another version", { v: 2 }],
    ["a blank name", { sourceDocId: " " }],
    ["no name", { sourceDocId: null }],
    ["a name over 140 characters", { sourceDocId: "x".repeat(141) }],
  ])("refuses %s", async (_label, extra) => {
    await client.query("savepoint s");
    await expect(client.query("select public.enqueue_hint($1::jsonb)", [hint(extra)])).rejects.toThrow(/enqueue_hint/);
    await client.query("rollback to savepoint s");
  });

  async function stateAs(role: string, sql: string): Promise<string | null> {
    await client.query("savepoint g");
    await client.query(`set local role ${role}`);
    const state = await sqlState(client, sql);
    await client.query("rollback to savepoint g");
    return state;
  }

  it.each(["anon", "authenticated"])("%s cannot execute it", async (role) => {
    expect(await stateAs(role, `select public.enqueue_hint('${hint()}'::jsonb)`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("service_role can execute it", async () => {
    expect(await stateAs("service_role", `select public.enqueue_hint('${hint()}'::jsonb)`)).toBeNull();
  });
});
