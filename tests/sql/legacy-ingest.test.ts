import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type pg from "pg";
import { parseFile } from "../../src/core/adapters/legacy/adapter.ts";
import { processBatch } from "../../src/services/consumer-service.ts";
import { toRecordMessage, type LegacyRecordMessage } from "../../src/services/legacy-ingest-service.ts";
import { pgRpc } from "./consumer-support.ts";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T12: register_file, source_file, the bucket, grants and the schedule (LOCAL db).
// Every test runs in a transaction that is rolled back. The T12 migrations are applied inside it, so the tests
// exercise the files in this branch and leave the shared local db untouched. Source B state is cleared inside
// the transaction so the tests don't depend on what the shared db holds.
const ROOT = join(__dirname, "..", "..");
const MIGRATIONS = ["20261018220000_legacy_ingest.sql", "20261018220100_legacy_ingest_schedule.sql"].map((f) =>
  readFileSync(join(ROOT, "supabase", "migrations", f), "utf8"),
);

type Prepared = { file: Record<string, unknown>; records: LegacyRecordMessage[] };

// The same steps legacyIngestService takes, from a data/ file (optionally under another name).
function prepare(dataFile: string, objectName = dataFile): Prepared {
  const bytes = new Uint8Array(readFileSync(join(ROOT, "data", dataFile)));
  const parsed = parseFile(bytes, objectName, parse);
  if (parsed.kind !== "parsed") throw new Error(parsed.reason);
  return {
    file: {
      objectName,
      exportedAt: parsed.exportDate,
      uploadedAt: "2026-10-18T12:00:00Z",
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      rowCount: parsed.rowCount,
      rejectReason: null,
    },
    records: parsed.candidates.map(toRecordMessage),
  };
}

type Sent = { kind: string; sourceDocId: string; sourceVersion: string };

let client: pg.Client;
let baselineMsgId = 0;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  for (const sql of MIGRATIONS) await client.query(sql);
  await client.query("delete from public.source_file");
  await client.query("delete from public.invoice where source = 'legacy_unit_b'");
  await client.query("delete from public.quarantine where source = 'legacy_unit_b'");
  await client.query("delete from internal.record_version where source = 'legacy_unit_b'");
  await client.query("delete from pgmq.q_invoice_events");
  const { rows } = await client.query<{ m: string | null }>("select max(msg_id)::text as m from pgmq.q_invoice_events");
  baselineMsgId = Number(rows[0]?.m ?? 0);
});

afterEach(async () => {
  await client.query("rollback");
});

async function register(p: Prepared): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>("select internal.register_file($1::jsonb, $2::jsonb) as r", [
    JSON.stringify(p.file),
    JSON.stringify(p.records),
  ]);
  return rows[0]!.r;
}

// Messages this test sent, in send order.
async function sent(): Promise<Sent[]> {
  const { rows } = await client.query<{ message: Sent }>("select message from pgmq.q_invoice_events where msg_id > $1 order by msg_id", [
    baselineMsgId,
  ]);
  return rows.map((r) => ({ kind: r.message.kind, sourceDocId: r.message.sourceDocId, sourceVersion: r.message.sourceVersion }));
}

async function drain(): Promise<void> {
  const { rows } = await client.query<{ m: string | null }>("select max(msg_id)::text as m from pgmq.q_invoice_events");
  baselineMsgId = Number(rows[0]?.m ?? 0);
}

// The real consumer path: processBatch (validate with the shipped mapping) -> apply_record, run until the
// queue is empty. beforeEach empties the queue inside the transaction, so only this test's messages are read.
async function applyAll(): Promise<void> {
  const rpc = pgRpc(client, "service_role");
  for (let runs = 0; runs < 100; runs++) {
    const result = await processBatch({ rpc, now: () => new Date() });
    expect(result.failed).toBe(0);
    if (result.read === 0) break;
  }
  await drain();
}

async function sourceFiles(): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query(
    `select object_name, to_char(exported_at, 'YYYY-MM-DD') as exported_at, status, reject_reason, row_count, same_content_as
     from public.source_file order by object_name`,
  );
  return rows;
}

describe("internal.register_file", () => {
  it("ingests a new snapshot: one record per invoice, no tombstone the first time", async () => {
    const p = prepare("unit_b_export_2026-10-16.csv");
    expect(await register(p)).toEqual({ status: "ingested", records: 85, tombstones: 0 });
    const messages = await sent();
    expect(messages).toHaveLength(85);
    expect(messages.every((m) => m.kind === "record" && m.sourceVersion === "2026-10-16")).toBe(true);
    const { rows } = await client.query("select message from pgmq.q_invoice_events where msg_id > $1 order by msg_id limit 1", [baselineMsgId]);
    expect(rows[0].message).toEqual(JSON.parse(JSON.stringify(p.records[0])));
    expect(await sourceFiles()).toEqual([
      { object_name: "unit_b_export_2026-10-16.csv", exported_at: "2026-10-16", status: "ingested", reject_reason: null, row_count: 183, same_content_as: null },
    ]);
    const versions = await client.query("select count(*)::int as n from internal.record_version where source = 'legacy_unit_b' and enqueued_version = '2026-10-16'");
    expect(versions.rows[0].n).toBe(85);
  });

  it("AC04/AC19/AC18 through the real consumer: the 10-16 export ends exactly as the README says", async () => {
    await register(prepare("unit_b_export_2026-10-16.csv"));
    await applyAll();
    expect(await sent()).toEqual([]);
    const { rows } = await client.query(
      `select source, source_doc_id, reason_code, status, first_rejected_at is not null as dated, coalesce(detail, '') <> '' as explained
       from public.quarantine where source = 'legacy_unit_b' order by source_doc_id`,
    );
    const row = (id: string, code: string) => ({ source: "legacy_unit_b", source_doc_id: id, reason_code: code, status: "open", dated: true, explained: true });
    expect(rows).toEqual([
      row("UB-26004", "TOTAL_MISMATCH"),
      row("UB-26005", "CONFLICTING_DUPLICATE"),
      row("UB-26010", "INVALID_DATE"),
      row("UB-26016", "TOTAL_MISMATCH"),
      row("UB-26023", "MISSING_FIELD"),
      row("UB-26077", "TOTAL_MISMATCH"),
      row("UB-26084", "UNSUPPORTED_CURRENCY"),
    ]);
    // None of the quarantined invoices is in the figures; AC19's two are, at their INV_TOTAL.
    const planted = ["UB-26004", "UB-26005", "UB-26010", "UB-26016", "UB-26023", "UB-26077", "UB-26084"];
    expect((await client.query("select count(*)::int as n from public.invoice where source_doc_id = any($1)", [planted])).rows).toEqual([{ n: 0 }]);
    const ac19 = await client.query("select source_doc_id, amount::text from public.invoice where source_doc_id in ('UB-26022', 'UB-26085') order by 1");
    expect(ac19.rows).toEqual([
      { source_doc_id: "UB-26022", amount: "1000.95" },
      { source_doc_id: "UB-26085", amount: "1111.25" },
    ]);
    // The figures the dashboard reads.
    const revenue = await client.query("select sum(revenue)::text as total, sum(invoices)::int as n from public.monthly_revenue where source = 'legacy_unit_b'");
    expect(revenue.rows).toEqual([{ total: "109915.83", n: 78 }]);
    // AC18: Unit B totals per canonical customer (README table, column "after 10-16").
    const perCustomer = await client.query(
      `select c.display_name, count(*)::int as n, sum(i.amount)::text as total
       from public.invoice i join public.customer c on c.canonical_id = i.canonical_customer_id
       where i.source = 'legacy_unit_b' group by 1 order by 1`,
    );
    expect(perCustomer.rows.map((r) => [r.display_name, r.n, r.total])).toEqual([
      ["Acme Foods Inc.", 9, "13985.03"],
      ["Blue Ridge Kitchens", 10, "12472.95"],
      ["Cedar Valley Bakery, Inc.", 9, "16298.98"],
      ["Harbor Lane Bistro", 9, "12094.95"],
      ["Lakeside Deli Co.", 9, "9014.02"],
      ["Old Mill Tavern", 10, "17471.71"],
      ["Pinecrest Senior Living", 4, "8798.78"],
      ["Redwood Pizza Kitchen", 9, "10682.35"],
      ["Sunset Grill & Taphouse", 9, "9097.06"],
    ]);
  });

  it("AC17: the README sequence 10-16, 10-17, 10-15", async () => {
    await register(prepare("unit_b_export_2026-10-16.csv"));
    await applyAll();
    // With the consumer simulated: the 7 planted errors in quarantine (AC04), 78 valid invoices (AC19 included).
    const quarantined = await client.query("select source_doc_id, reason_code from public.quarantine where source = 'legacy_unit_b' order by 1");
    expect(quarantined.rows.map((r) => [r.source_doc_id, r.reason_code])).toEqual([
      ["UB-26004", "TOTAL_MISMATCH"],
      ["UB-26005", "CONFLICTING_DUPLICATE"],
      ["UB-26010", "INVALID_DATE"],
      ["UB-26016", "TOTAL_MISMATCH"],
      ["UB-26023", "MISSING_FIELD"],
      ["UB-26077", "TOTAL_MISMATCH"],
      ["UB-26084", "UNSUPPORTED_CURRENCY"],
    ]);
    const figures = await client.query("select count(*)::int as n, sum(amount)::text as total from public.invoice where source = 'legacy_unit_b'");
    expect(figures.rows).toEqual([{ n: 78, total: "109915.83" }]);

    // 10-17: UB-26001 (valid) and UB-26010 (quarantined) are gone -> exactly two tombstones.
    expect(await register(prepare("unit_b_export_2026-10-17.csv"))).toEqual({ status: "ingested", records: 83, tombstones: 2 });
    const second = await sent();
    expect(second.filter((m) => m.kind === "tombstone")).toEqual([
      { kind: "tombstone", sourceDocId: "UB-26001", sourceVersion: "2026-10-17" },
      { kind: "tombstone", sourceDocId: "UB-26010", sourceVersion: "2026-10-17" },
    ]);
    await applyAll();
    const q = await client.query("select status, resolution from public.quarantine where source_doc_id = 'UB-26010'");
    expect(q.rows).toEqual([{ status: "resolved", resolution: "removed_from_export" }]);

    // 10-15: older than the newest -> rejected whole, nothing sent.
    expect(await register(prepare("unit_b_export_2026-10-15.csv"))).toEqual({
      status: "rejected",
      reason: "older than 2026-10-17",
      records: 0,
      tombstones: 0,
    });
    expect(await sent()).toEqual([]);
    expect((await sourceFiles()).map((f) => [f["object_name"], f["status"], f["reject_reason"]])).toEqual([
      ["unit_b_export_2026-10-15.csv", "rejected", "older than 2026-10-17"],
      ["unit_b_export_2026-10-16.csv", "ingested", null],
      ["unit_b_export_2026-10-17.csv", "ingested", null],
    ]);
  });

  it("tombstones keys that are only in invoice, only in open quarantine, or still in flight; not resolved ones", async () => {
    await client.query(`
      insert into public.invoice (source, source_doc_id, source_customer, invoice_date, currency, amount, source_version, mapping_version, candidate, raw_ref)
      values ('legacy_unit_b', 'OLD-INV', 'A', '2026-01-02', 'USD', 1, '2026-10-01', 0, '{}', 'x')`);
    await client.query(`
      insert into public.quarantine (source, source_doc_id, reason_code, source_version) values
        ('legacy_unit_b', 'OLD-Q-OPEN', 'TOTAL_MISMATCH', '2026-10-01'),
        ('legacy_unit_b', 'OLD-Q-RESOLVED', 'TOTAL_MISMATCH', '2026-10-01')`);
    await client.query("update public.quarantine set status = 'resolved', resolved_at = now(), resolution = 'valid' where source_doc_id = 'OLD-Q-RESOLVED'");
    await client.query(`
      insert into internal.record_version (source, source_doc_id, applied_version, enqueued_version) values
        ('legacy_unit_b', 'OLD-IN-FLIGHT', null, '2026-10-01'),
        ('legacy_unit_b', 'OLD-APPLIED-GONE', '2026-10-01', '2026-10-01'),
        ('erpnext', 'OLD-OTHER-SOURCE', null, '1|2026-10-01 00:00:00.000000')
      on conflict do nothing`);
    await client.query("insert into public.source_file (object_name, exported_at, content_sha256, status) values ('unit_b_export_2026-10-01.csv', '2026-10-01', 'aa', 'ingested')");

    expect(await register(prepare("unit_b_export_2026-10-16.csv"))).toMatchObject({ records: 85, tombstones: 3 });
    expect((await sent()).filter((m) => m.kind === "tombstone").map((m) => m.sourceDocId)).toEqual(["OLD-IN-FLIGHT", "OLD-INV", "OLD-Q-OPEN"]);
    const rv = await client.query("select enqueued_version from internal.record_version where source = 'legacy_unit_b' and source_doc_id = 'OLD-Q-OPEN'");
    expect(rv.rows).toEqual([{ enqueued_version: "2026-10-16" }]);
  });

  it("EC08: a newer export that fixes UB-26004's total sends it again with the newer version", async () => {
    await register(prepare("unit_b_export_2026-10-16.csv"));
    await applyAll();
    expect((await client.query("select reason_code from public.quarantine where source_doc_id = 'UB-26004'")).rows).toEqual([
      { reason_code: "TOTAL_MISMATCH" },
    ]);
    const text = readFileSync(join(ROOT, "data", "unit_b_export_2026-10-17.csv"), "utf8").replace(/^(UB-26004,.*),1452\.40$/gm, "$1,1407.40");
    const name = "unit_b_export_2026-10-18.csv";
    const parsed = parseFile(text, name, parse);
    if (parsed.kind !== "parsed") throw new Error(parsed.reason);
    const fixed = parsed.candidates.find((c) => c.sourceDocId === "UB-26004");
    expect([fixed?.netTotal, fixed?.parseIssues]).toEqual([1407.4, []]);
    const file = { objectName: name, exportedAt: "2026-10-18", uploadedAt: null, contentSha256: createHash("sha256").update(text).digest("hex"), rowCount: parsed.rowCount, rejectReason: null };
    expect(await register({ file, records: parsed.candidates.map(toRecordMessage) })).toEqual({ status: "ingested", records: 83, tombstones: 2 });
    expect((await sent()).find((m) => m.sourceDocId === "UB-26004")).toEqual({ kind: "record", sourceDocId: "UB-26004", sourceVersion: "2026-10-18" });
    await applyAll(); // the consumer's part, simulated: valid now -> invoice, quarantine row gone
    expect((await client.query("select amount from public.invoice where source_doc_id = 'UB-26004'")).rows).toEqual([{ amount: "1407.40" }]);
  });

  it("EC06/AC14: same content as the newest file under a newer date only moves the export date", async () => {
    await register(prepare("unit_b_export_2026-10-17.csv"));
    await drain();
    expect(await register(prepare("unit_b_export_2026-10-17.csv", "unit_b_export_2026-10-18.csv"))).toEqual({
      status: "ingested",
      sameContentAs: "unit_b_export_2026-10-17.csv",
      records: 0,
      tombstones: 0,
    });
    expect(await sent()).toEqual([]);
    expect((await sourceFiles())[1]).toEqual({
      object_name: "unit_b_export_2026-10-18.csv",
      exported_at: "2026-10-18",
      status: "ingested",
      reject_reason: null,
      row_count: 180,
      same_content_as: "unit_b_export_2026-10-17.csv",
    });
    // The newest export date is now 10-18: a 10-17-dated file would be older.
    const late = prepare("unit_b_export_2026-10-16.csv", "folder/unit_b_export_2026-10-17.csv");
    expect(await register(late)).toMatchObject({ status: "rejected", reason: "older than 2026-10-18" });
  });

  it("content equal to an older (not the newest) file is processed normally", async () => {
    await register(prepare("unit_b_export_2026-10-16.csv"));
    await applyAll();
    await register(prepare("unit_b_export_2026-10-17.csv"));
    await applyAll();
    const back = prepare("unit_b_export_2026-10-16.csv", "unit_b_export_2026-10-19.csv");
    expect(await register(back)).toEqual({ status: "ingested", records: 85, tombstones: 0 });
    expect((await sent()).every((m) => m.kind === "record" && m.sourceVersion === "2026-10-19")).toBe(true);
  });

  it("EC07: a file rejected by the whole-file checks is recorded and sends nothing", async () => {
    const file = { objectName: "unit_b_export_2026-10-20.csv", exportedAt: "2026-10-20", uploadedAt: null, contentSha256: "ab", rowCount: null, rejectReason: "file is empty" };
    expect(await register({ file, records: [] })).toEqual({ status: "rejected", reason: "file is empty", records: 0, tombstones: 0 });
    expect(await sent()).toEqual([]);
    expect(await sourceFiles()).toEqual([
      { object_name: "unit_b_export_2026-10-20.csv", exported_at: "2026-10-20", status: "rejected", reject_reason: "file is empty", row_count: null, same_content_as: null },
    ]);
    // A rejected file never becomes "the newest".
    expect(await register(prepare("unit_b_export_2026-10-16.csv"))).toMatchObject({ status: "ingested" });
  });

  it("an undated name is rejected with a null export date", async () => {
    const file = { objectName: "notes.csv", exportedAt: null, uploadedAt: null, contentSha256: null, rowCount: null, rejectReason: "bad name" };
    expect(await register({ file, records: [] })).toMatchObject({ status: "rejected", reason: "bad name" });
  });

  it("an object already registered is a no-op (overlapping or retried run)", async () => {
    const p = prepare("unit_b_export_2026-10-16.csv");
    await register(p);
    await drain();
    expect(await register(p)).toEqual({ status: "already_registered", records: 0, tombstones: 0 });
    expect(await sent()).toEqual([]);
  });

  it("refuses records that don't match the file and leaves nothing behind", async () => {
    const p = prepare("unit_b_export_2026-10-16.csv");
    const wrongVersion = { ...p, records: p.records.map((r, i) => (i === 3 ? { ...r, sourceVersion: "2026-10-15" } : r)) };
    await client.query("savepoint s");
    await expect(register(wrongVersion)).rejects.toThrow(/every record needs/);
    await client.query("rollback to savepoint s");
    const dup = { ...p, records: [...p.records, p.records[0]!] };
    await expect(register(dup)).rejects.toThrow(/duplicate sourceDocId/);
    await client.query("rollback to savepoint s");
    await expect(register({ ...p, records: [] })).rejects.toThrow(/non-empty/);
    await client.query("rollback to savepoint s");
    expect(await sourceFiles()).toEqual([]);
  });
});

describe("public.unregistered_files", () => {
  it("returns the names not in source_file", async () => {
    await register(prepare("unit_b_export_2026-10-16.csv"));
    const { rows } = await client.query("select * from public.unregistered_files(array['unit_b_export_2026-10-16.csv', 'unit_b_export_2026-10-17.csv'])");
    expect(rows).toEqual([{ unregistered_files: "unit_b_export_2026-10-17.csv" }]);
  });
});

describe("grants", () => {
  const CALLS = [
    "select public.register_file('{}'::jsonb, '[]'::jsonb)",
    "select * from public.unregistered_files(array['x'])",
    "select internal.register_file('{}'::jsonb, '[]'::jsonb)",
    "select internal.trigger_legacy_ingest()",
    "select * from public.source_file",
  ];

  async function stateAs(role: string, sql: string): Promise<string | null> {
    await client.query("savepoint g");
    await client.query(`set local role ${role}`);
    const state = await sqlState(client, sql);
    await client.query("rollback to savepoint g");
    return state;
  }

  it.each(["anon", "authenticated"])("%s can't call the T12 functions or read source_file", async (role) => {
    for (const sql of CALLS) expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
  });

  it("service_role can call the wrappers and read source_file", async () => {
    expect(await stateAs("service_role", "select * from public.unregistered_files(array['x'])")).toBeNull();
    expect(await stateAs("service_role", "select * from public.source_file")).toBeNull();
  });

  it("only service_role (and the owner) holds EXECUTE on the wrappers", async () => {
    const { rows } = await client.query<{ fn: string; grantees: string[] }>(`
      select p.proname as fn, array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text) as grantees
      from pg_proc p, aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('register_file', 'unregistered_files')
        and a.privilege_type = 'EXECUTE'
      group by p.proname order by 1`);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.grantees.filter((g) => g !== "postgres")).toEqual(["service_role"]);
  });

  it("source_file has RLS on", async () => {
    const { rows } = await client.query("select relrowsecurity from pg_class where oid = 'public.source_file'::regclass");
    expect(rows).toEqual([{ relrowsecurity: true }]);
  });
});

describe("schedule and storage", () => {
  it("schedules legacy-ingest every 5 minutes through internal.trigger_legacy_ingest", async () => {
    const { rows } = await client.query("select schedule, command from cron.job where jobname = 'legacy-ingest'");
    expect(rows).toEqual([{ schedule: "*/5 * * * *", command: "select internal.trigger_legacy_ingest()" }]);
  });

  it("has a private legacy-uploads bucket with no storage policy for it", async () => {
    const { rows } = await client.query("select public, file_size_limit from storage.buckets where id = 'legacy-uploads'");
    expect(rows).toEqual([{ public: false, file_size_limit: "2097152" }]);
    const policies = await client.query("select policyname from pg_policies where schemaname = 'storage' and (qual ilike '%legacy-uploads%' or with_check ilike '%legacy-uploads%')");
    expect(policies.rows).toEqual([]);
  });
});
