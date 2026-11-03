import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CanonicalCandidate } from "../../src/core/canonical.ts";
import { processBatch } from "../../src/services/consumer-service.ts";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { shippedMapping, type MappingEntry } from "../mapping/mapping-file.ts";
import { applyBranchMigrations, currentMappingVersion } from "./branch-migrations.ts";
import { apply, outcomeOf, pgRpc, send, testDocs } from "./consumer-support.ts";
import { connect } from "./db.ts";

// T15: a mapping change re-validates the affected records (R15, EC09, AC15, AC16). LOCAL db, rolled back.
// The real invoices of the shared db are moved out of the way inside the transaction, so the queue holds
// only this test's revalidate messages.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await applyBranchMigrations(client);
  await client.query("delete from public.invoice where true");
  await client.query("delete from public.quarantine where true");
  await client.query("delete from pgmq.q_invoice_events");
});

afterEach(async () => {
  await client.query("rollback");
});

const run = () => processBatch({ rpc: pgRpc(client, "service_role"), now: () => new Date() });

async function applyMapping(mapping: MappingEntry[]): Promise<void> {
  await client.query("select internal.apply_customer_mapping($1::jsonb)", [JSON.stringify(mapping)]);
}

async function queuedRevalidations(): Promise<string[]> {
  const { rows } = await client.query<{ m: { kind: string; source: string; sourceDocId: string } }>(
    "select message as m from pgmq.q_invoice_events order by msg_id",
  );
  return rows.map((r) => `${r.m.kind}:${r.m.source}:${r.m.sourceDocId}`);
}

async function revenue(): Promise<string> {
  const { rows } = await client.query<{ s: string }>("select coalesce(sum(amount), 0)::text as s from public.invoice");
  return rows[0]!.s;
}

async function quarantine(source: string, key: string) {
  const { rows } = await client.query("select reason_code, status, resolution from public.quarantine where source = $1 and source_doc_id = $2", [source, key]);
  return rows[0];
}

async function invoiceCustomer(source: string, key: string): Promise<string | undefined> {
  const { rows } = await client.query("select canonical_customer_id from public.invoice where source = $1 and source_doc_id = $2", [source, key]);
  return rows[0]?.canonical_customer_id;
}

function legacyRecord(key: string, customer: string) {
  const candidate: CanonicalCandidate = {
    source: "legacy_unit_b",
    sourceDocId: key,
    sourceVersion: "2026-10-16",
    rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
    sourceCustomer: customer,
    invoiceDate: "2026-02-10",
    currency: "USD",
    isCreditNote: false,
    status: "final",
    netTotal: 300,
    lines: [{ lineNo: 1, itemCode: null, description: "Rice", qty: 10, unitPrice: 30, netAmount: 300 }],
    parseIssues: [],
  };
  return { v: 1, kind: "record", source: "legacy_unit_b", sourceDocId: key, sourceVersion: "2026-10-16", rawRef: candidate.rawRef, candidate };
}

describe("apply_customer_mapping enqueues revalidate", () => {
  it("for open UNKNOWN_CUSTOMER rows and for invoices of customers whose aliases changed, nothing else", async () => {
    const mv = await currentMappingVersion(client);
    const [blue, other] = testDocs();
    await apply(client, outcomeOf(blue!, mv), 0); // blue-ridge-kitchens
    const unknown = { ...other!, customer: "Brand New Diner" };
    expect(await apply(client, outcomeOf(unknown, mv), 0)).toBe("invalid");
    const mismatch = { ...testDocs()[2]!, base_net_total: 1 };
    expect(await apply(client, outcomeOf(mismatch, mv), 0)).toBe("invalid"); // TOTAL_MISMATCH: not re-validated

    // Unchanged mapping: only the UNKNOWN_CUSTOMER row.
    await applyMapping(shippedMapping());
    expect(await queuedRevalidations()).toEqual([`revalidate:erpnext:${unknown.name}`]);
    await client.query("delete from pgmq.q_invoice_events");

    // A Unit B alias added to Blue Ridge Kitchens: its invoices too.
    const changed = shippedMapping().map((e) => (e.canonical_id === "blue-ridge-kitchens" ? { ...e, legacy_unit_b: [...e.legacy_unit_b, "BRK"] } : e));
    await applyMapping(changed);
    expect((await queuedRevalidations()).sort()).toEqual([`revalidate:erpnext:${blue!.name}`, `revalidate:erpnext:${unknown.name}`].sort());
  });

  it("for invoices stored before any mapping (no canonical customer)", async () => {
    const mv = await currentMappingVersion(client);
    const doc = testDocs()[0]!;
    await apply(client, outcomeOf(doc, mv), 0);
    await client.query("update public.invoice set canonical_customer_id = null where source_doc_id = $1", [doc.name]);
    await applyMapping(shippedMapping());
    expect(await queuedRevalidations()).toEqual([`revalidate:erpnext:${doc.name}`]);
  });

  it("in the same transaction as the mapping: a failed mapping enqueues nothing", async () => {
    const mv = await currentMappingVersion(client);
    await apply(client, outcomeOf({ ...testDocs()[0]!, customer: "Brand New Diner" }, mv), 0);
    await client.query("savepoint s");
    await expect(applyMapping([...shippedMapping(), shippedMapping()[0]!])).rejects.toThrow();
    await client.query("rollback to savepoint s");
    expect(await queuedRevalidations()).toEqual([]);
  });
});

describe("AC15: a customer added to the mapping leaves quarantine and enters the figures", () => {
  it("for a Source B record", async () => {
    const key = `T-UB-${randomUUID().slice(0, 8)}`;
    await send(client, legacyRecord(key, "Brand New Diner, LLC"));
    expect(await run()).toMatchObject({ invalid: 1 });
    expect(await quarantine("legacy_unit_b", key)).toEqual({ reason_code: "UNKNOWN_CUSTOMER", status: "open", resolution: null });
    expect(await revenue()).toBe("0");

    await applyMapping([
      ...shippedMapping(),
      { canonical_id: "brand-new-diner", display_name: "Brand New Diner, LLC", erpnext: [], legacy_unit_b: ["BRAND NEW DINER LLC"] },
    ]);
    expect(await run()).toMatchObject({ read: 1, valid: 1, failed: 0 });
    expect(await quarantine("legacy_unit_b", key)).toEqual({ reason_code: "UNKNOWN_CUSTOMER", status: "resolved", resolution: "valid" });
    expect(await invoiceCustomer("legacy_unit_b", key)).toBe("brand-new-diner");
    expect(await revenue()).toBe("300.00");
  });

  it("for an ERPNext record", async () => {
    const doc = { ...testDocs()[0]!, customer: "Brand New Diner" };
    await send(client, recordMessage(doc));
    expect(await run()).toMatchObject({ invalid: 1 });
    await applyMapping([...shippedMapping(), { canonical_id: "brand-new-diner", display_name: "Brand New Diner", erpnext: ["Brand New Diner"], legacy_unit_b: [] }]);
    expect(await run()).toMatchObject({ valid: 1 });
    expect(await invoiceCustomer("erpnext", doc.name!)).toBe("brand-new-diner");
  });
});

describe("AC16: an alias removed from the mapping sends its invoices to quarantine", () => {
  it("and takes their amount out of the figures", async () => {
    const docs = testDocs();
    for (const doc of docs) await send(client, recordMessage(doc));
    expect(await run()).toMatchObject({ valid: 5 });
    const before = await revenue();
    expect(before).toBe("10922.00");

    const withoutAlias = shippedMapping().map((e) => (e.canonical_id === "blue-ridge-kitchens" ? { ...e, erpnext: [] } : e));
    await applyMapping(withoutAlias);
    expect(await run()).toMatchObject({ read: 5, invalid: 5, failed: 0 });
    expect(await revenue()).toBe("0");
    for (const doc of docs) expect(await quarantine("erpnext", doc.name!)).toMatchObject({ reason_code: "UNKNOWN_CUSTOMER", status: "open" });

    // Putting the alias back brings them back.
    await applyMapping(shippedMapping());
    expect(await run()).toMatchObject({ read: 5, valid: 5 });
    expect(await revenue()).toBe(before);
  });

  it("moves invoices to the customer an alias now points at", async () => {
    const key = `T-UB-${randomUUID().slice(0, 8)}`;
    await send(client, legacyRecord(key, "ACME FOODS"));
    await run();
    expect(await invoiceCustomer("legacy_unit_b", key)).toBe("acme-foods");
    const moved = shippedMapping().map((e) =>
      e.canonical_id === "acme-foods" ? { ...e, legacy_unit_b: [] } : e.canonical_id === "old-mill-tavern" ? { ...e, legacy_unit_b: [...e.legacy_unit_b, "Acme Foods"] } : e,
    );
    await applyMapping(moved);
    expect(await run()).toMatchObject({ valid: 1 });
    expect(await invoiceCustomer("legacy_unit_b", key)).toBe("old-mill-tavern");
  });
});

describe("revalidate edge cases", () => {
  it("acknowledges a revalidate whose record is gone", async () => {
    await send(client, { v: 1, kind: "revalidate", source: "erpnext", sourceDocId: "T15TEST-GONE" });
    expect(await run()).toMatchObject({ read: 1, skipped: 1, failed: 0 });
    expect(await queuedRevalidations()).toEqual([]);
  });

  it("never brings back a PROCESSING_FAILED record", async () => {
    const mv = await currentMappingVersion(client);
    const doc = testDocs()[0]!;
    await apply(client, outcomeOf(doc, mv), 0);
    const msgId = await send(client, { v: 1, kind: "revalidate", source: "erpnext", sourceDocId: doc.name });
    await client.query("select public.dead_letter_message($1, 'x')", [msgId]);
    expect(await quarantine("erpnext", doc.name!)).toMatchObject({ reason_code: "PROCESSING_FAILED" });
    await send(client, { v: 1, kind: "revalidate", source: "erpnext", sourceDocId: doc.name });
    expect(await run()).toMatchObject({ skipped: 1, valid: 0 });
    expect(await revenue()).toBe("0");
  });

  it("an outcome computed before the mapping changed is refused and retried with the new mapping", async () => {
    const doc = { ...testDocs()[0]!, customer: "Brand New Diner" };
    const msgId = await send(client, recordMessage(doc));
    const stale = outcomeOf(doc, await currentMappingVersion(client));
    await applyMapping([...shippedMapping(), { canonical_id: "brand-new-diner", display_name: "Brand New Diner", erpnext: ["Brand New Diner"], legacy_unit_b: [] }]);
    await client.query("savepoint s");
    await expect(apply(client, stale, msgId)).rejects.toThrow(/mapping_version/);
    await client.query("rollback to savepoint s");
    await client.query("delete from pgmq.q_invoice_events where msg_id <> $1", [msgId]);
    expect(await run()).toMatchObject({ valid: 1 });
  });

  it("load_stored_record and ack_invoice_event are service_role only", async () => {
    const { rows } = await client.query(
      `select has_function_privilege('service_role', 'public.load_stored_record(text, text)', 'EXECUTE') as a,
              has_function_privilege('service_role', 'public.ack_invoice_event(bigint)', 'EXECUTE') as b,
              has_function_privilege('anon', 'public.load_stored_record(text, text)', 'EXECUTE') as c,
              has_function_privilege('authenticated', 'public.ack_invoice_event(bigint)', 'EXECUTE') as d,
              has_function_privilege('authenticated', 'internal.load_stored_record(text, text)', 'EXECUTE') as e`,
    );
    expect(rows[0]).toEqual({ a: true, b: true, c: false, d: false, e: false });
  });
});
