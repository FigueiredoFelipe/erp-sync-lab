import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T6: enqueue_page, the sync_run wrappers, their grants and the poll schedule (LOCAL db).
// Every test runs in a transaction that is rolled back. The T6 migrations are (re)applied inside that
// transaction, so the tests exercise the files in this branch and leave the shared local db untouched.
const MIGRATIONS = ["20261018190600_enqueue_page.sql", "20261018190601_erpnext_poll_schedule.sql"].map((f) =>
  readFileSync(join(__dirname, "..", "..", "supabase", "migrations", f), "utf8"),
);

const ID = "T6-TEST-0001";
const ID2 = "T6-TEST-0002";

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
  // Start from a known cursor state for Source A, whatever the shared db holds.
  await client.query("delete from internal.sync_cursor where source = 'erpnext' and stream = 'invoices'");
});

afterEach(async () => {
  await client.query("rollback");
});

function msg(id: string, version: string, extra: Record<string, unknown> = {}) {
  return { v: 1, kind: "record", source: "erpnext", sourceDocId: id, sourceVersion: version, rawRef: `erpnext/${id}/x.json`, doc: { name: id }, ...extra };
}

async function enqueue(messages: unknown[], modified: string, name: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select internal.enqueue_page('erpnext', $1::jsonb, $2, $3) as n", [
    JSON.stringify(messages),
    modified,
    name,
  ]);
  return rows[0]!.n;
}

async function queued(): Promise<{ sourceDocId: string; sourceVersion: string }[]> {
  const { rows } = await client.query<{ message: { sourceDocId: string; sourceVersion: string } }>(
    "select message from pgmq.q_invoice_events where message->>'sourceDocId' like 'T6-TEST-%' order by msg_id",
  );
  return rows.map((r) => ({ sourceDocId: r.message.sourceDocId, sourceVersion: r.message.sourceVersion }));
}

async function cursor(): Promise<{ modified: string; name: string } | null> {
  const { rows } = await client.query<{ modified: string; name: string }>("select * from public.read_sync_cursor('erpnext', 'invoices')");
  return rows[0] ?? null;
}

describe("internal.enqueue_page", () => {
  it("sends every new message as is and returns the count", async () => {
    const m = msg(ID, "1|2026-10-17 20:39:07.886022");
    expect(await enqueue([m, msg(ID2, "1|2026-10-17 20:39:08.000000")], "2026-10-17 20:39:08.000000", ID2)).toBe(2);
    const { rows } = await client.query("select message from pgmq.q_invoice_events where message->>'sourceDocId' = $1", [ID]);
    expect(rows.map((r) => r.message)).toEqual([m]);
    const versions = await client.query(
      "select source_doc_id, enqueued_version, applied_version from internal.record_version where source_doc_id like 'T6-TEST-%' order by 1",
    );
    expect(versions.rows).toEqual([
      { source_doc_id: ID, enqueued_version: "1|2026-10-17 20:39:07.886022", applied_version: null },
      { source_doc_id: ID2, enqueued_version: "1|2026-10-17 20:39:08.000000", applied_version: null },
    ]);
  });

  it("skips a version <= enqueued_version and sends a newer one", async () => {
    await enqueue([msg(ID, "1|2026-10-17 20:39:07.886022")], "2026-10-17 20:39:07.886022", ID);
    expect(await enqueue([msg(ID, "1|2026-10-17 20:39:07.886022")], "2026-10-17 20:39:07.886022", ID)).toBe(0);
    expect(await enqueue([msg(ID, "1|2026-10-17 20:39:06.000000")], "2026-10-17 20:39:07.886022", ID)).toBe(0);
    expect(await enqueue([msg(ID, "2|2026-10-17 20:00:00.000000")], "2026-10-17 20:39:07.886022", ID)).toBe(1);
    expect(await queued()).toEqual([
      { sourceDocId: ID, sourceVersion: "1|2026-10-17 20:39:07.886022" },
      { sourceDocId: ID, sourceVersion: "2|2026-10-17 20:00:00.000000" },
    ]);
  });

  it("skips a message already dead-lettered at that version, but not a newer version", async () => {
    await client.query(
      "insert into public.dead_letter (msg_id, source, source_doc_id, source_version, attempts, payload) values (-6001, 'erpnext', $1, $2, 6, '{}')",
      [ID, "1|2026-10-17 20:39:07.886022"],
    );
    expect(await enqueue([msg(ID, "1|2026-10-17 20:39:07.886022")], "2026-10-17 20:39:07.886022", ID)).toBe(0);
    expect(await enqueue([msg(ID, "1|2026-10-17 21:00:00.000000")], "2026-10-17 21:00:00.000000", ID)).toBe(1);
  });

  it("returns 0 for an empty page", async () => {
    expect(await enqueue([], "2026-10-17 20:00:00.000000", ID)).toBe(0);
  });

  it("refuses a message without a key or version, or from another source", async () => {
    expect(await sqlState(client, "savepoint s")).toBeNull();
    await expect(enqueue([{ ...msg(ID, ""), sourceVersion: undefined }], "2026-10-17 20:00:00.000000", ID)).rejects.toThrow(/sourceVersion/);
    await client.query("rollback to savepoint s");
    await expect(enqueue([msg(ID, "1|x", { source: "legacy_unit_b" })], "2026-10-17 20:00:00.000000", ID)).rejects.toThrow(/source/);
    await client.query("rollback to savepoint s");
  });

  it("creates the cursor, then moves it forward only", async () => {
    expect(await cursor()).toBeNull();
    await enqueue([], "2026-10-17 20:39:07.886022", "ACC-SINV-2026-00005");
    expect(await cursor()).toEqual({ modified: "2026-10-17 20:39:07.886022", name: "ACC-SINV-2026-00005" });

    await enqueue([], "2026-10-17 19:00:00.000000", "ACC-SINV-2026-00009"); // overlap re-read: behind
    expect(await cursor()).toEqual({ modified: "2026-10-17 20:39:07.886022", name: "ACC-SINV-2026-00005" });

    await enqueue([], "2026-10-17 20:39:07.886022", "ACC-SINV-2026-00004"); // same modified, smaller name
    expect(await cursor()).toEqual({ modified: "2026-10-17 20:39:07.886022", name: "ACC-SINV-2026-00005" });

    await enqueue([], "2026-10-17 20:39:07.886022", "ACC-SINV-2026-00006"); // same modified, larger name
    expect(await cursor()).toEqual({ modified: "2026-10-17 20:39:07.886022", name: "ACC-SINV-2026-00006" });

    await enqueue([], "2026-10-18 01:02:03.000004", "ACC-SINV-2026-00001"); // later modified
    expect(await cursor()).toEqual({ modified: "2026-10-18 01:02:03.000004", name: "ACC-SINV-2026-00001" });
  });

  it("is reachable from service_role only through the public wrapper", async () => {
    const call = `select public.enqueue_page('erpnext', '[]'::jsonb, '2026-10-17 20:00:00', '${ID}')`;
    await client.query("savepoint s");
    await client.query("set local role service_role");
    expect(await sqlState(client, call)).toBeNull();
    await client.query("rollback to savepoint s");
  });
});

describe("sync_run wrappers", () => {
  it("start_sync_run marks runs left running for over 10 minutes as failed and opens a new one", async () => {
    await client.query("update public.sync_run set status = 'failed', finished_at = now() where source = 'erpnext' and status = 'running'");
    const stale = await client.query<{ id: string }>(
      "insert into public.sync_run (source, started_at) values ('erpnext', now() - interval '11 minutes') returning id",
    );
    const recent = await client.query<{ id: string }>(
      "insert into public.sync_run (source, started_at) values ('erpnext', now() - interval '2 minutes') returning id",
    );
    const { rows } = await client.query<{ id: string }>("select public.start_sync_run('erpnext') as id");
    const newId = rows[0]!.id;

    const status = async (id: string) =>
      (await client.query("select status, finished_at is not null as finished, error from public.sync_run where id = $1", [id])).rows[0];
    expect(await status(stale.rows[0]!.id)).toEqual({ status: "failed", finished: true, error: "abandoned: still running after 10 minutes" });
    expect(await status(recent.rows[0]!.id)).toMatchObject({ status: "running", finished: false });
    expect(await status(newId)).toMatchObject({ status: "running", finished: false });
  });

  it("finish_sync_run records counts, error and the fetched log; refuses 'running'", async () => {
    const { rows } = await client.query<{ id: string }>("select public.start_sync_run('erpnext') as id");
    const id = rows[0]!.id;
    const fetched = [{ name: ID, sourceVersion: "1|2026-10-17 20:39:07.886022" }];
    await client.query("select public.finish_sync_run($1, 'succeeded', 2, 150, 140, null, $2::jsonb)", [id, JSON.stringify(fetched)]);
    const run = await client.query("select status, pages, fetched_count, enqueued, error, fetched, finished_at is not null as finished from public.sync_run where id = $1", [id]);
    expect(run.rows[0]).toEqual({ status: "succeeded", pages: 2, fetched_count: 150, enqueued: 140, error: null, fetched, finished: true });

    await client.query("savepoint s");
    await expect(client.query("select public.finish_sync_run($1, 'failed', 0, 0, 0, 'x', '[]')", [id])).rejects.toThrow(/no running sync_run/);
    await client.query("rollback to savepoint s");
    const { rows: again } = await client.query<{ id: string }>("select public.start_sync_run('erpnext') as id");
    await expect(client.query("select public.finish_sync_run($1, 'running', 0, 0, 0, null, '[]')", [again[0]!.id])).rejects.toThrow(/invalid status/);
    await client.query("rollback to savepoint s");
  });

  it("last_sync_run_status is the latest finished run's status, ignoring running ones", async () => {
    await client.query("delete from public.sync_run where source = 'erpnext'");
    expect((await client.query("select public.last_sync_run_status('erpnext') as s")).rows[0].s).toBeNull();
    await client.query(`insert into public.sync_run (source, started_at, finished_at, status) values
      ('erpnext', now() - interval '20 minutes', now() - interval '19 minutes', 'succeeded'),
      ('erpnext', now() - interval '10 minutes', now() - interval '9 minutes', 'incomplete'),
      ('erpnext', now() - interval '1 minute', null, 'running')`);
    expect((await client.query("select public.last_sync_run_status('erpnext') as s")).rows[0].s).toBe("incomplete");
  });

  it("read_sync_cursor returns the fixed-width modified ERPNext uses", async () => {
    await client.query("insert into internal.sync_cursor (source, stream, cursor_modified, cursor_name) values ('erpnext', 'invoices', '2026-10-17 20:39:07.5', 'A')");
    expect(await cursor()).toEqual({ modified: "2026-10-17 20:39:07.500000", name: "A" });
  });
});

describe("grants", () => {
  const WRAPPERS = [
    "select public.enqueue_page('erpnext', '[]'::jsonb, '2026-10-17 20:00:00', 'x')",
    "select * from public.read_sync_cursor('erpnext', 'invoices')",
    "select public.start_sync_run('erpnext')",
    "select public.finish_sync_run(gen_random_uuid(), 'failed', 0, 0, 0, null, '[]')",
    "select public.last_sync_run_status('erpnext')",
    "select internal.enqueue_page('erpnext', '[]'::jsonb, '2026-10-17 20:00:00', 'x')",
    "select internal.trigger_poll()",
  ];

  async function stateAs(role: string, sql: string): Promise<string | null> {
    await client.query("savepoint g");
    await client.query(`set local role ${role}`);
    const state = await sqlState(client, sql);
    await client.query("rollback to savepoint g");
    return state;
  }

  it.each(["anon", "authenticated"])("%s cannot execute any T6 function", async (role) => {
    for (const sql of WRAPPERS) expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
  });

  it("service_role can execute the wrappers", async () => {
    for (const sql of WRAPPERS.slice(0, 3).concat(WRAPPERS[4]!)) expect({ sql, state: await stateAs("service_role", sql) }).toEqual({ sql, state: null });
  });

  it("only service_role (and the owner) holds EXECUTE on the public wrappers", async () => {
    const { rows } = await client.query<{ fn: string; grantees: string[] }>(`
      select p.proname as fn, array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text) as grantees
      from pg_proc p, aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('enqueue_page', 'read_sync_cursor', 'start_sync_run', 'finish_sync_run', 'last_sync_run_status')
        and a.privilege_type = 'EXECUTE'
      group by p.proname order by 1`);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.grantees.filter((g) => g !== "postgres")).toEqual(["service_role"]);
  });
});

describe("schedule and storage", () => {
  it("schedules erpnext-poll every 5 minutes through internal.trigger_poll", async () => {
    const { rows } = await client.query("select schedule, command from cron.job where jobname = 'erpnext-poll'");
    expect(rows).toEqual([{ schedule: "*/5 * * * *", command: "select internal.trigger_poll()" }]);
  });

  it("has a private raw bucket", async () => {
    const { rows } = await client.query("select public from storage.buckets where id = 'raw'");
    expect(rows).toEqual([{ public: false }]);
  });
});
