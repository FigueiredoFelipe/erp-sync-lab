import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T16: reconciliation tables, wrappers, grants and schedule (LOCAL db). Each test runs in a rolled-back
// transaction that applies the T16 migration, so the shared local db is left untouched.
const MIGRATION = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261018210100_reconciliation.sql"), "utf8");

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

async function stateAs(role: string, sql: string): Promise<string | null> {
  await client.query("savepoint g");
  await client.query(`set local role ${role}`);
  const state = await sqlState(client, sql);
  await client.query("rollback to savepoint g");
  return state;
}

async function startRun(): Promise<string> {
  return (await client.query<{ id: string }>("select public.start_reconciliation_run() as id")).rows[0]!.id;
}

describe("runs and results", () => {
  it("finish_reconciliation_run records totals and results in one call", async () => {
    const id = await startRun();
    const results = [
      { month: "2026-03-01", sourceDocId: null, erpAmount: "125.00", storedAmount: "100.00", class: "summary" },
      { month: "2026-03-01", sourceDocId: "T16-B", erpAmount: "25.00", storedAmount: "0.00", class: "unexplained" },
    ];
    await client.query("select public.finish_reconciliation_run($1, 'succeeded', 125, 100, 1, null, $2::jsonb)", [id, JSON.stringify(results)]);
    const run = await client.query("select status, erp_total::text, stored_total::text, unexplained, error, finished_at is not null as finished from public.reconciliation_run where id = $1", [id]);
    expect(run.rows).toEqual([{ status: "succeeded", erp_total: "125.00", stored_total: "100.00", unexplained: 1, error: null, finished: true }]);
    const rows = await client.query(
      "select month::text, source_doc_id, erp_amount::text, stored_amount::text, class from public.reconciliation_result where run_id = $1 order by source_doc_id nulls first",
      [id],
    );
    expect(rows.rows).toEqual([
      { month: "2026-03-01", source_doc_id: null, erp_amount: "125.00", stored_amount: "100.00", class: "summary" },
      { month: "2026-03-01", source_doc_id: "T16-B", erp_amount: "25.00", stored_amount: "0.00", class: "unexplained" },
    ]);
  });

  it("refuses a second finish, an invalid status, an invalid class and a summary with a document", async () => {
    const id = await startRun();
    await client.query("select public.finish_reconciliation_run($1, 'failed', null, null, null, 'erp down', '[]')", [id]);
    for (const [sql, params, pattern] of [
      ["select public.finish_reconciliation_run($1, 'failed', null, null, null, 'x', '[]')", [id], /no running/],
      ["select public.finish_reconciliation_run($1, 'running', null, null, null, null, '[]')", [await startRun()], /invalid status/],
    ] as const) {
      await client.query("savepoint s");
      await expect(client.query(sql, [...params])).rejects.toThrow(pattern);
      await client.query("rollback to savepoint s");
    }
    for (const row of [
      { month: "2026-03-01", sourceDocId: "X", erpAmount: 1, storedAmount: 0, class: "bogus" },
      { month: "2026-03-01", sourceDocId: "X", erpAmount: 1, storedAmount: 0, class: "summary" },
      { month: "2026-03-05", sourceDocId: "X", erpAmount: 1, storedAmount: 0, class: "unexplained" },
    ]) {
      const next = await startRun();
      await client.query("savepoint s");
      await expect(client.query("select public.finish_reconciliation_run($1, 'succeeded', 1, 0, 0, null, $2::jsonb)", [next, JSON.stringify([row])])).rejects.toThrow();
      await client.query("rollback to savepoint s");
    }
  });

  it("start_reconciliation_run closes runs left running for over 10 minutes", async () => {
    const stale = await client.query<{ id: string }>("insert into public.reconciliation_run (started_at) values (now() - interval '11 minutes') returning id");
    await startRun();
    const { rows } = await client.query("select status, error from public.reconciliation_run where id = $1", [stale.rows[0]!.id]);
    expect(rows).toEqual([{ status: "failed", error: "abandoned: still running after 10 minutes" }]);
  });
});

describe("reconciliation_snapshot", () => {
  it("returns the cursor, stored invoices in the period, pending, quarantined and dead-lettered keys", async () => {
    await client.query("delete from internal.sync_cursor where source = 'erpnext' and stream = 'invoices'");
    await client.query("insert into internal.sync_cursor (source, stream, cursor_modified, cursor_name) values ('erpnext', 'invoices', '2026-10-18 09:00:00.5', 'T16-CUR')");
    await client.query(`insert into public.invoice (source, source_doc_id, source_customer, invoice_date, currency, amount, source_version, mapping_version, candidate, raw_ref)
      values ('erpnext', 'T16-IN', 'c', '2026-03-10', 'USD', 12.5, '1|2026-03-10 00:00:00.000000', 0, '{}', 'r'),
             ('erpnext', 'T16-OUT', 'c', '2025-12-31', 'USD', 1, '1|2025-12-31 00:00:00.000000', 0, '{}', 'r')`);
    await client.query("select pgmq.send('invoice_events', '{\"source\":\"erpnext\",\"sourceDocId\":\"T16-PENDING\"}'::jsonb)");
    await client.query("insert into public.quarantine (source, source_doc_id, reason_code, source_version) values ('erpnext', 'T16-Q', 'MISSING_FIELD', '1|x')");
    await client.query("insert into public.dead_letter (msg_id, source, source_doc_id, attempts, payload) values (-16001, 'erpnext', 'T16-D', 6, '{}')");

    const snap = (await client.query("select public.reconciliation_snapshot('2026-01-01', '2026-12-31') as s")).rows[0].s;
    expect(snap.cursor).toEqual({ modified: "2026-10-18 09:00:00.500000", name: "T16-CUR" });
    expect(snap.invoices).toContainEqual({ id: "T16-IN", amount: "12.50", invoiceDate: "2026-03-10" });
    expect(snap.invoices.map((i: { id: string }) => i.id)).not.toContain("T16-OUT");
    expect(snap.pending).toContain("T16-PENDING");
    expect(snap.quarantined).toContain("T16-Q");
    expect(snap.deadLettered).toContain("T16-D");
  });
});

describe("grants and schedule", () => {
  const CALLS = [
    "select public.start_reconciliation_run()",
    "select public.reconciliation_snapshot('2026-01-01', '2026-12-31')",
    "select public.finish_reconciliation_run(gen_random_uuid(), 'failed', null, null, null, null, '[]')",
    "select internal.trigger_reconcile()",
  ];

  it.each(["anon", "authenticated"])("%s reaches neither the tables nor the functions", async (role) => {
    for (const sql of [...CALLS, "select * from public.reconciliation_run", "select * from public.reconciliation_result", "insert into public.reconciliation_run default values"]) {
      expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
    }
  });

  it("service_role can execute the wrappers and read the tables", async () => {
    for (const sql of [CALLS[0]!, CALLS[1]!, "select * from public.reconciliation_run", "select * from public.reconciliation_result"]) {
      expect({ sql, state: await stateAs("service_role", sql) }).toEqual({ sql, state: null });
    }
  });

  it("has RLS on both tables", async () => {
    const { rows } = await client.query(
      "select relname, relrowsecurity from pg_class where oid in ('public.reconciliation_run'::regclass, 'public.reconciliation_result'::regclass) order by 1",
    );
    expect(rows).toEqual([
      { relname: "reconciliation_result", relrowsecurity: true },
      { relname: "reconciliation_run", relrowsecurity: true },
    ]);
  });

  it("schedules reconcile-erpnext daily through internal.trigger_reconcile", async () => {
    const { rows } = await client.query("select schedule, command from cron.job where jobname = 'reconcile-erpnext'");
    expect(rows).toEqual([{ schedule: "0 6 * * *", command: "select internal.trigger_reconcile()" }]);
  });
});
