import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T14: enqueue_page per stream (LOCAL db). Each test runs in a rolled-back transaction that (re)applies
// the T6 migration and the T14 migration on top, so the shared local db is left untouched.
const MIGRATIONS = ["20261018190600_enqueue_page.sql", "20261018210000_enqueue_page_stream.sql"].map((f) =>
  readFileSync(join(__dirname, "..", "..", "supabase", "migrations", f), "utf8"),
);

const ID = "T14-TEST-0001";

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  for (const sql of MIGRATIONS) await client.query(sql);
  await client.query("delete from internal.sync_cursor where source = 'erpnext'");
});

afterEach(async () => {
  await client.query("rollback");
});

function record(version: string) {
  return { v: 1, kind: "record", source: "erpnext", sourceDocId: ID, sourceVersion: version, rawRef: `erpnext/${ID}/x.json`, doc: { name: ID } };
}

function tombstone(creation: string) {
  return { v: 1, kind: "tombstone", source: "erpnext", sourceDocId: ID, sourceVersion: `3|${creation}`, rawRef: `erpnext/deleted/${ID}.json` };
}

async function enqueue(stream: string | null, messages: unknown[], modified: string, name: string): Promise<number> {
  const sql =
    stream === null
      ? "select public.enqueue_page('erpnext', $1::jsonb, $2, $3) as n"
      : "select public.enqueue_page('erpnext', $4, $1::jsonb, $2, $3) as n";
  const params = stream === null ? [JSON.stringify(messages), modified, name] : [JSON.stringify(messages), modified, name, stream];
  const { rows } = await client.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

async function cursor(stream: string): Promise<{ modified: string; name: string } | null> {
  const { rows } = await client.query<{ modified: string; name: string }>("select * from public.read_sync_cursor('erpnext', $1)", [stream]);
  return rows[0] ?? null;
}

async function queued(): Promise<{ kind: string; sourceVersion: string }[]> {
  const { rows } = await client.query<{ message: { kind: string; sourceVersion: string } }>(
    "select message from pgmq.q_invoice_events where message->>'sourceDocId' = $1 order by msg_id",
    [ID],
  );
  return rows.map((r) => ({ kind: r.message.kind, sourceVersion: r.message.sourceVersion }));
}

describe("enqueue_page per stream", () => {
  it("moves only the deleted cursor for the deleted stream", async () => {
    await enqueue("invoices", [], "2026-10-18 09:00:00.000000", "ACC-SINV-2026-00010");
    await enqueue("deleted", [], "2026-10-18 10:00:00.000001", "24h0000001");
    expect(await cursor("invoices")).toEqual({ modified: "2026-10-18 09:00:00.000000", name: "ACC-SINV-2026-00010" });
    expect(await cursor("deleted")).toEqual({ modified: "2026-10-18 10:00:00.000001", name: "24h0000001" });

    await enqueue("deleted", [], "2026-10-18 08:00:00.000000", "zzz"); // overlap re-read: behind
    expect(await cursor("deleted")).toEqual({ modified: "2026-10-18 10:00:00.000001", name: "24h0000001" });
    expect(await cursor("invoices")).toEqual({ modified: "2026-10-18 09:00:00.000000", name: "ACC-SINV-2026-00010" });
  });

  it("keeps the T6 signature working, on the invoices stream", async () => {
    await enqueue(null, [record("1|2026-10-18 09:00:00.000000")], "2026-10-18 09:00:00.000000", ID);
    expect(await cursor("invoices")).toEqual({ modified: "2026-10-18 09:00:00.000000", name: ID });
    expect(await cursor("deleted")).toBeNull();
  });

  it("EC12: a tombstone after the record is sent once, and a replay of it is skipped", async () => {
    expect(await enqueue("invoices", [record("1|2026-10-18 09:00:00.000000")], "2026-10-18 09:00:00.000000", ID)).toBe(1);
    expect(await enqueue("deleted", [tombstone("2026-10-18 10:00:00.000001")], "2026-10-18 10:00:00.000001", "24h0000001")).toBe(1);
    expect(await enqueue("deleted", [tombstone("2026-10-18 10:00:00.000001")], "2026-10-18 10:00:00.000001", "24h0000001")).toBe(0);
    // A late re-read of the old submission can't be re-sent behind the tombstone.
    expect(await enqueue("invoices", [record("2|2026-10-18 09:30:00.000000")], "2026-10-18 09:30:00.000000", ID)).toBe(0);
    expect(await queued()).toEqual([
      { kind: "record", sourceVersion: "1|2026-10-18 09:00:00.000000" },
      { kind: "tombstone", sourceVersion: "3|2026-10-18 10:00:00.000001" },
    ]);
    const { rows } = await client.query("select enqueued_version from internal.record_version where source = 'erpnext' and source_doc_id = $1", [ID]);
    expect(rows).toEqual([{ enqueued_version: "3|2026-10-18 10:00:00.000001" }]);
  });

  it("refuses an unknown stream", async () => {
    await client.query("savepoint s");
    await expect(enqueue("orders", [], "2026-10-18 09:00:00", ID)).rejects.toThrow(/unknown stream/);
    await client.query("rollback to savepoint s");
  });
});

describe("grants", () => {
  const CALLS = [
    "select public.enqueue_page('erpnext', 'deleted', '[]'::jsonb, '2026-10-18 09:00:00', 'x')",
    "select public.enqueue_page('erpnext', '[]'::jsonb, '2026-10-18 09:00:00', 'x')",
    "select internal.enqueue_page('erpnext', 'deleted', '[]'::jsonb, '2026-10-18 09:00:00', 'x')",
  ];

  async function stateAs(role: string, sql: string): Promise<string | null> {
    await client.query("savepoint g");
    await client.query(`set local role ${role}`);
    const state = await sqlState(client, sql);
    await client.query("rollback to savepoint g");
    return state;
  }

  it.each(["anon", "authenticated"])("%s cannot execute either signature", async (role) => {
    for (const sql of CALLS) expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
  });

  it("service_role can execute both public signatures", async () => {
    for (const sql of CALLS.slice(0, 2)) expect({ sql, state: await stateAs("service_role", sql) }).toEqual({ sql, state: null });
  });

  it("only service_role (and the owner) holds EXECUTE on both public overloads", async () => {
    const { rows } = await client.query<{ args: string; grantees: string[] }>(`
      select pg_get_function_identity_arguments(p.oid) as args,
             array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text) as grantees
      from pg_proc p, aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace and p.proname = 'enqueue_page' and a.privilege_type = 'EXECUTE'
      group by p.oid order by 1`);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.grantees.filter((g) => g !== "postgres")).toEqual(["service_role"]);
  });
});
