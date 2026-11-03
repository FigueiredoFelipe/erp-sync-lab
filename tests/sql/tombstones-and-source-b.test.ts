import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CanonicalCandidate } from "../../src/core/canonical.ts";
import { processBatch } from "../../src/services/consumer-service.ts";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { applyBranchMigrations, currentMappingVersion } from "./branch-migrations.ts";
import { apply, messageExists, outcomeOf, pgRpc, send, testDocs, withVersion } from "./consumer-support.ts";
import { connect } from "./db.ts";

// Tombstones (EC12, BR10) and Source B records through apply_record and processBatch (LOCAL db).
// Each test runs in a rolled-back transaction with this branch's migrations; the queue is emptied first.

let client: pg.Client;
let mv: number;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await applyBranchMigrations(client);
  await client.query("delete from pgmq.q_invoice_events");
  mv = await currentMappingVersion(client);
});

afterEach(async () => {
  await client.query("rollback");
});

const NOW = () => new Date();
const run = () => processBatch({ rpc: pgRpc(client, "service_role"), now: NOW });
const DELETED = "3|2026-10-18 14:00:00.000000";

function erpTombstone(name: string, version = DELETED) {
  return { v: 1, kind: "tombstone", source: "erpnext", sourceDocId: name, sourceVersion: version, rawRef: `erpnext/${name}/deleted.json` };
}

const OBJECT = "unit_b_export_2026-10-16.csv";

function legacyCandidate(invNo: string, exportDate = "2026-10-16", overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    source: "legacy_unit_b",
    sourceDocId: invNo,
    sourceVersion: exportDate,
    rawRef: `legacy-uploads/unit_b_export_${exportDate}.csv`,
    sourceCustomer: "ACME FOODS",
    invoiceDate: "2026-03-02",
    currency: "USD",
    isCreditNote: false,
    status: "final",
    netTotal: 120.5,
    lines: [
      { lineNo: 1, itemCode: null, description: "Flour", qty: 2, unitPrice: 40.25, netAmount: 80.5 },
      { lineNo: 2, itemCode: null, description: "Oil", qty: 1, unitPrice: 40, netAmount: 40 },
    ],
    parseIssues: [],
    ...overrides,
  };
}

function legacyRecord(candidate: CanonicalCandidate) {
  return { v: 1, kind: "record", source: "legacy_unit_b", sourceDocId: candidate.sourceDocId, sourceVersion: candidate.sourceVersion, rawRef: candidate.rawRef, candidate };
}

function legacyTombstone(invNo: string, exportDate = "2026-10-17") {
  return { v: 1, kind: "tombstone", source: "legacy_unit_b", sourceDocId: invNo, sourceVersion: exportDate };
}

const ubKey = () => `T-UB-${randomUUID().slice(0, 8)}`;

async function invoice(source: string, key: string) {
  const { rows } = await client.query(
    "select amount::text, canonical_customer_id, source_version, invoice_date::text from public.invoice where source = $1 and source_doc_id = $2",
    [source, key],
  );
  return rows[0];
}

async function quarantine(source: string, key: string) {
  const { rows } = await client.query("select reason_code, status, resolution from public.quarantine where source = $1 and source_doc_id = $2", [source, key]);
  return rows[0];
}

async function appliedVersion(source: string, key: string): Promise<string | null> {
  const { rows } = await client.query("select applied_version from internal.record_version where source = $1 and source_doc_id = $2", [source, key]);
  return rows[0]?.applied_version ?? null;
}

async function failsWith(outcome: unknown): Promise<string | null> {
  await client.query("savepoint s");
  try {
    await client.query("select public.apply_record($1::jsonb, 0)", [JSON.stringify(outcome)]);
    await client.query("release savepoint s");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint s");
    return (error as Error).message;
  }
}

describe("ERPNext tombstone (EC12)", () => {
  it("takes a stored invoice out of the figures as cancelled", async () => {
    const doc = testDocs()[0]!;
    await apply(client, outcomeOf(doc, mv), 0);
    const msgId = await send(client, erpTombstone(doc.name!));
    expect(await run()).toMatchObject({ read: 1, cancelled: 1, failed: 0 });
    expect(await invoice("erpnext", doc.name!)).toBeUndefined();
    expect(await messageExists(client, msgId)).toBe(false);
    expect(await appliedVersion("erpnext", doc.name!)).toBe(DELETED);
  });

  it("closes an open quarantine row with resolution cancelled", async () => {
    const doc = { ...testDocs()[0]!, base_net_total: 1 };
    expect(await apply(client, outcomeOf(doc, mv), 0)).toBe("invalid");
    await send(client, erpTombstone(doc.name!));
    await run();
    expect(await quarantine("erpnext", doc.name!)).toMatchObject({ status: "resolved", resolution: "cancelled" });
  });

  it("is a no-op for a key still in flight, recording its version so the older record is refused later", async () => {
    const doc = testDocs()[1]!;
    await client.query("insert into internal.record_version (source, source_doc_id, enqueued_version) values ('erpnext', $1, '1|2026-10-17 20:39:08.378782')", [
      doc.name,
    ]);
    const tomb = await send(client, erpTombstone(doc.name!));
    expect(await run()).toMatchObject({ read: 1, cancelled: 1, failed: 0 });
    expect(await messageExists(client, tomb)).toBe(false);
    expect(await appliedVersion("erpnext", doc.name!)).toBe(DELETED);
    expect(await quarantine("erpnext", doc.name!)).toBeUndefined();

    await send(client, recordMessage(doc));
    await send(client, recordMessage(withVersion(doc, 2, "2026-10-18 13:59:00.000000")));
    expect(await run()).toMatchObject({ read: 2, stale: 2, valid: 0 });
    expect(await invoice("erpnext", doc.name!)).toBeUndefined();
  });

  it("refuses a 3| version on anything but a candidate-less cancelled outcome", async () => {
    const doc = testDocs()[0]!;
    const valid = outcomeOf(doc, mv);
    const asDeleted = { ...valid, sourceVersion: DELETED, candidate: { ...valid.candidate, sourceVersion: DELETED } };
    expect(await failsWith(asDeleted)).toMatch(/only cancels/);
    expect(await failsWith({ kind: "removed", source: "erpnext", sourceDocId: doc.name, sourceVersion: "1|2026-10-17 20:39:07.886022", candidate: null })).toMatch(
      /only to legacy_unit_b/,
    );
  });

  it("is dead-lettered, not applied, when its version is malformed", async () => {
    await send(client, erpTombstone("ACC-SINV-X", "3|2026-10-18 14:00:00"));
    expect(await run()).toMatchObject({ read: 1, failed: 1, cancelled: 0 });
  });
});

describe("Source B record", () => {
  it("validates the candidate it carries and stores it under its canonical customer", async () => {
    const key = ubKey();
    const msgId = await send(client, legacyRecord(legacyCandidate(key)));
    expect(await run()).toMatchObject({ read: 1, valid: 1, failed: 0 });
    expect(await invoice("legacy_unit_b", key)).toEqual({
      amount: "120.50",
      canonical_customer_id: "acme-foods",
      source_version: "2026-10-16",
      invoice_date: "2026-03-02",
    });
    const { rows } = await client.query("select count(*)::int as n from public.invoice_line where source = 'legacy_unit_b' and source_doc_id = $1", [key]);
    expect(rows[0].n).toBe(2);
    expect(await messageExists(client, msgId)).toBe(false);
  });

  it.each([
    ["CONFLICTING_DUPLICATE", { parseIssues: ["CONFLICTING_DUPLICATE" as const], netTotal: 999 }],
    ["TOTAL_MISMATCH", { netTotal: 125.5 }],
    ["INVALID_DATE", { invoiceDate: null, parseIssues: ["INVALID_DATE" as const] }],
    ["MISSING_FIELD", { sourceCustomer: null }],
    ["UNSUPPORTED_CURRENCY", { currency: "EUR", sourceCustomer: "REDWOOD  PIZZA KITCHEN" }],
    ["UNKNOWN_CUSTOMER", { sourceCustomer: "Acme Foods Inc." }],
  ])("quarantines a candidate with %s", async (code, overrides) => {
    const key = ubKey();
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-16", overrides)));
    expect(await run()).toMatchObject({ read: 1, invalid: 1, failed: 0 });
    expect(await quarantine("legacy_unit_b", key)).toEqual({ reason_code: code, status: "open", resolution: null });
    expect(await invoice("legacy_unit_b", key)).toBeUndefined();
  });

  it("quarantines a row without INV_NO under its #row key, with unreadable amounts, as MISSING_FIELD (Q8)", async () => {
    const key = `${OBJECT}#row${Math.floor(Math.random() * 1e6)}`;
    const candidate = legacyCandidate(key, "2026-10-16", {
      parseIssues: ["MISSING_FIELD"],
      netTotal: null,
      lines: [{ lineNo: 1, itemCode: null, description: "Flour", qty: null as unknown as number, unitPrice: 3, netAmount: null as unknown as number }],
    });
    await send(client, legacyRecord(candidate));
    expect(await run()).toMatchObject({ read: 1, invalid: 1, failed: 0 });
    expect(await quarantine("legacy_unit_b", key)).toMatchObject({ reason_code: "MISSING_FIELD" });
  });

  it("a newer export that fixes the invoice moves it from quarantine to the figures (EC08)", async () => {
    const key = ubKey();
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-16", { netTotal: 999 })));
    await run();
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-17")));
    expect(await run()).toMatchObject({ valid: 1 });
    expect(await quarantine("legacy_unit_b", key)).toMatchObject({ status: "resolved", resolution: "valid" });
    expect(await invoice("legacy_unit_b", key)).toMatchObject({ source_version: "2026-10-17" });
  });

  it("is malformed when the candidate's key or version differs from the message", async () => {
    const key = ubKey();
    const msg = legacyRecord(legacyCandidate(key));
    await send(client, { ...msg, sourceVersion: "2026-10-17" });
    expect(await run()).toMatchObject({ read: 1, failed: 1 });
  });
});

describe("Source B tombstone (BR10, AC17)", () => {
  it("removes a valid invoice from the figures", async () => {
    const key = ubKey();
    await send(client, legacyRecord(legacyCandidate(key)));
    await run();
    await send(client, legacyTombstone(key));
    expect(await run()).toMatchObject({ read: 1, removed: 1, failed: 0 });
    expect(await invoice("legacy_unit_b", key)).toBeUndefined();
    expect(await appliedVersion("legacy_unit_b", key)).toBe("2026-10-17");
  });

  it("closes an open quarantine row as removed_from_export", async () => {
    const key = ubKey();
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-16", { invoiceDate: null, parseIssues: ["INVALID_DATE"] })));
    await run();
    await send(client, legacyTombstone(key));
    await run();
    expect(await quarantine("legacy_unit_b", key)).toEqual({ reason_code: "INVALID_DATE", status: "resolved", resolution: "removed_from_export" });
  });

  it("is a no-op for a key still in flight, and the older record is then refused as stale", async () => {
    const key = ubKey();
    const tomb = await send(client, legacyTombstone(key));
    expect(await run()).toMatchObject({ read: 1, removed: 1, failed: 0 });
    expect(await messageExists(client, tomb)).toBe(false);
    expect(await appliedVersion("legacy_unit_b", key)).toBe("2026-10-17");
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-16")));
    expect(await run()).toMatchObject({ read: 1, stale: 1, valid: 0 });
    expect(await invoice("legacy_unit_b", key)).toBeUndefined();
  });

  it("lets the invoice back in when a newer export lists it again", async () => {
    const key = ubKey();
    await send(client, legacyTombstone(key, "2026-10-17"));
    await run();
    await send(client, legacyRecord(legacyCandidate(key, "2026-10-18")));
    expect(await run()).toMatchObject({ valid: 1 });
    expect(await invoice("legacy_unit_b", key)).toMatchObject({ source_version: "2026-10-18" });
  });

  it("refuses cancelled for Source B, and a timestamp version", async () => {
    expect(await failsWith({ kind: "cancelled", source: "legacy_unit_b", sourceDocId: "UB-1", sourceVersion: "2026-10-17", candidate: null })).toMatch(
      /only to erpnext/,
    );
    expect(await failsWith({ kind: "removed", source: "legacy_unit_b", sourceDocId: "UB-1", sourceVersion: "1|2026-10-17 20:39:07.886022" })).toMatch(
      /invalid sourceVersion/,
    );
  });
});
