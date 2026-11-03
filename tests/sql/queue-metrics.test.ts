import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T18: public.app_queue_metrics on the LOCAL stack, applied inside a transaction that is rolled back.
const MIGRATION = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261018230100_queue_metrics.sql"), "utf8");

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  // Load the migration only where it isn't applied yet (the shared local DB may already have it).
  const { rows } = await client.query<{ present: boolean }>("select to_regprocedure('public.app_queue_metrics()') is not null as present");
  if (!rows[0]?.present) await client.query(MIGRATION);
});

afterEach(async () => {
  await client.query("rollback");
});

type Metric = { queue_name: string; queue_length: string; oldest_msg_age_sec: number | null };

async function metrics(): Promise<Map<string, Metric>> {
  const { rows } = await client.query<Metric>("select * from public.app_queue_metrics()");
  return new Map(rows.map((r) => [r.queue_name, r]));
}

describe("public.app_queue_metrics", () => {
  it("reports the length and oldest message age of the main queue and the DLQ", async () => {
    // T22: the wrapper answers only service_role and allowlisted users, so read as service_role throughout.
    await client.query("set local role service_role");
    const before = await metrics();
    expect([...before.keys()].sort()).toEqual(["invoice_events", "invoice_events_dlq"]);

    // An old message: enqueued, then backdated by 15 minutes (rolled back with the transaction).
    await client.query("reset role");
    const { rows } = await client.query<{ id: string }>(
      `select * from pgmq.send('invoice_events', '{"v":1,"kind":"probe","sourceDocId":"T18-PROBE"}'::jsonb) as id`,
    );
    await client.query("update pgmq.q_invoice_events set enqueued_at = now() - interval '15 minutes' where msg_id = $1", [rows[0]!.id]);

    await client.query("set local role service_role");
    const after = await metrics();
    const main = after.get("invoice_events")!;
    expect(Number(main.queue_length)).toBe(Number(before.get("invoice_events")!.queue_length) + 1);
    expect(main.oldest_msg_age_sec).toBeGreaterThanOrEqual(15 * 60);
  });

  it("cannot be executed by anon", async () => {
    await client.query("set local role anon");
    expect(await sqlState(client, "select * from public.app_queue_metrics()")).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // T22: authenticated may execute it, but gets nothing unless allowlisted (tests/sql/auth-allowlist.test.ts).
  it("returns nothing to an authenticated user who is not allowlisted", async () => {
    await client.query("set local role authenticated");
    const { rows } = await client.query("select * from public.app_queue_metrics()");
    expect(rows).toEqual([]);
  });
});
