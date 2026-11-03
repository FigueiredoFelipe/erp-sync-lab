import { describe, expect, it, jest } from "@jest/globals";
import type { ErpInvoiceDoc } from "../core/adapters/erpnext/adapter.ts";
import type { CanonicalCandidate } from "../core/canonical.ts";
import {
  backoffSeconds,
  ConsumerBlockedError,
  describeReason,
  HINT_BUDGET_MS,
  parseMessage,
  processBatch,
  MalformedMessageError,
  TestSwitchCrash,
  type Outcome,
  type QueueMessage,
  type RpcClient,
  type RpcResult,
} from "./consumer-service.ts";
import { fixtureDocs, recordMessage } from "./test-helpers.ts";
import { toCandidate } from "../core/adapters/erpnext/adapter.ts";
import { buildCustomerIndex } from "../core/customers/resolve.ts";
import { SourceUnavailableError } from "../core/sync/contracts.ts";
import type { HintResolution } from "./webhook-service.ts";

type Call = { fn: string; args: Record<string, unknown> };

// In-memory fake of the SQL wrappers: records every call, counts attempts, echoes the outcome kind.
function fakeRpc(
  messages: QueueMessage[],
  opts: { attempts?: Record<number, number>; failApplyFor?: number[]; deadLetterResult?: string | null; stored?: unknown } = {},
) {
  const calls: Call[] = [];
  const attempts = new Map<number, number>(Object.entries(opts.attempts ?? {}).map(([k, v]) => [Number(k), v]));
  const rpc: RpcClient = {
    async rpc(fn, args = {}): Promise<RpcResult> {
      calls.push({ fn, args });
      switch (fn) {
        case "read_invoice_events":
          return { data: messages, error: null };
        case "begin_attempt": {
          const id = args["p_msg_id"] as number;
          const next = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, next);
          return { data: next, error: null };
        }
        case "apply_record": {
          if (opts.failApplyFor?.includes(args["p_msg_id"] as number)) return { data: null, error: { message: "boom" } };
          return { data: (args["p_outcome"] as Outcome).kind, error: null };
        }
        case "load_customer_index":
          return { data: { mappingVersion: 4, aliases: [{ source: "erpnext", matchKey: "Blue Ridge Kitchens", canonicalId: "blue-ridge-kitchens" }] }, error: null };
        case "load_stored_record":
          return { data: opts.stored ?? null, error: null };
        case "ack_invoice_event":
          return { data: true, error: null };
        case "dead_letter_message":
          if (opts.deadLetterResult === null) return { data: null, error: { message: "dlq down" } };
          return { data: opts.deadLetterResult ?? "moved", error: null };
        case "set_invoice_event_vt":
        case "write_consumer_heartbeat":
          return { data: null, error: null };
        default:
          return { data: null, error: { message: `unexpected rpc ${fn}` } };
      }
    },
  };
  return { rpc, calls };
}

function queued(message: unknown, msgId: number): QueueMessage {
  return { msg_id: msgId, read_ct: 1, enqueued_at: "2026-10-18T12:00:00Z", message };
}

const NOW = () => new Date("2026-10-18T12:01:00Z");

function applied(calls: Call[]): Outcome[] {
  return calls.filter((c) => c.fn === "apply_record").map((c) => c.args["p_outcome"] as Outcome);
}

function vtCalls(calls: Call[]): { msgId: unknown; seconds: unknown }[] {
  return calls.filter((c) => c.fn === "set_invoice_event_vt").map((c) => ({ msgId: c.args["p_msg_id"], seconds: c.args["p_seconds"] }));
}

function doc(index = 0): ErpInvoiceDoc {
  return fixtureDocs()[index]!;
}

// The candidate the ERPNext adapter makes of fixture 0, as stored with an invoice.
function decideFromDoc() {
  return toCandidate(doc(0), "erpnext/ACC-SINV-2026-00001/1-2026-10-17 20:39:07.886022.json");
}

describe("processBatch", () => {
  it("reads at most 10 messages with a 180 s visibility timeout", async () => {
    const { rpc, calls } = fakeRpc([]);
    const result = await processBatch({ rpc, now: NOW });
    expect(calls[0]).toEqual({ fn: "read_invoice_events", args: { p_vt: 180, p_qty: 10 } });
    expect(result).toEqual({ read: 0, valid: 0, invalid: 0, cancelled: 0, removed: 0, stale: 0, skipped: 0, failed: 0, deadLettered: 0 });
    expect(calls.at(-1)).toEqual({ fn: "write_consumer_heartbeat", args: { p_processed: 0, p_oldest_message_age: null, p_dead_lettered: 0 } });
  });

  it("applies a valid invoice with its candidate and the message id", async () => {
    const { rpc, calls } = fakeRpc([queued(recordMessage(doc(0)), 11)]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result.valid).toBe(1);
    const [outcome] = applied(calls);
    expect(outcome).toMatchObject({
      kind: "valid",
      source: "erpnext",
      sourceDocId: "ACC-SINV-2026-00001",
      sourceVersion: "1|2026-10-17 20:39:07.886022",
      candidate: { netTotal: 1166, sourceCustomer: "Blue Ridge Kitchens", invoiceDate: "2026-01-14" },
      mappingVersion: 4,
      canonicalCustomerId: "blue-ridge-kitchens",
    });
    expect(outcome?.reasonCode).toBeUndefined();
    expect(calls.find((c) => c.fn === "apply_record")?.args["p_msg_id"]).toBe(11);
    // begin_attempt runs before apply_record.
    expect(calls.map((c) => c.fn)).toEqual(["read_invoice_events", "load_customer_index", "begin_attempt", "apply_record", "write_consumer_heartbeat"]);
    expect(calls.at(-1)?.args).toEqual({ p_processed: 1, p_oldest_message_age: "60.000 seconds", p_dead_lettered: 0 });
  });

  it("sends an invalid invoice with exactly one reason code and a detail", async () => {
    const bad = doc(0);
    bad.base_net_total = 1000; // lines add up to 1166
    const { rpc, calls } = fakeRpc([queued(recordMessage(bad), 1)]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result.invalid).toBe(1);
    const [outcome] = applied(calls);
    expect(outcome?.kind).toBe("invalid");
    expect(outcome?.reasonCode).toBe("TOTAL_MISMATCH");
    expect(outcome?.detail).toContain("1166");
  });

  it("quarantines a customer the mapping doesn't list as UNKNOWN_CUSTOMER (BR05)", async () => {
    const stranger = doc(0);
    stranger.customer = "Somebody New LLC";
    const { rpc, calls } = fakeRpc([queued(recordMessage(stranger), 1)]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result.invalid).toBe(1);
    expect(applied(calls)[0]).toMatchObject({ kind: "invalid", reasonCode: "UNKNOWN_CUSTOMER", mappingVersion: 4, canonicalCustomerId: null });
    expect(applied(calls)[0]?.detail).toContain("Somebody New LLC");
  });

  it("loads the customer mapping once per non-empty batch, and not for an empty one", async () => {
    const docs = fixtureDocs();
    const { rpc, calls } = fakeRpc(docs.map((d, i) => queued(recordMessage(d), i + 1)));
    await processBatch({ rpc, now: NOW });
    expect(calls.filter((c) => c.fn === "load_customer_index")).toHaveLength(1);
    const empty = fakeRpc([]);
    await processBatch({ rpc: empty.rpc, now: NOW });
    expect(empty.calls.some((c) => c.fn === "load_customer_index")).toBe(false);
  });

  it("fails the batch, before any attempt, when the mapping can't be loaded", async () => {
    const { rpc, calls } = fakeRpc([queued(recordMessage(doc(0)), 1)]);
    const broken: RpcClient = {
      rpc: (fn, args) => (fn === "load_customer_index" ? Promise.resolve({ data: null, error: { message: "nope" } }) : rpc.rpc(fn, args)),
    };
    await expect(processBatch({ rpc: broken, now: NOW })).rejects.toThrow(
      new ConsumerBlockedError("customer mapping unusable, no message processed: load_customer_index failed: nope"),
    );
    expect(calls.some((c) => c.fn === "begin_attempt")).toBe(false);
  });

  it("is loud when the mapping is ambiguous: heartbeat with nothing processed, then a blocking error", async () => {
    const { rpc, calls } = fakeRpc([queued(recordMessage(doc(0)), 1)]);
    const ambiguous: RpcClient = {
      rpc: (fn, args) =>
        fn === "load_customer_index"
          ? Promise.resolve({
              data: {
                mappingVersion: 5,
                aliases: [
                  { source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" },
                  { source: "legacy_unit_b", matchKey: "Acme Foods", canonicalId: "acme-co" },
                ],
              },
              error: null,
            })
          : rpc.rpc(fn, args),
    };
    const error = await processBatch({ rpc: ambiguous, now: NOW }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConsumerBlockedError);
    expect((error as Error).message).toMatch(/customer mapping unusable.*ambiguous: acme-foods and acme-co/);
    expect(calls.map((c) => c.fn)).toEqual(["read_invoice_events", "write_consumer_heartbeat"]);
    expect(calls.at(-1)?.args).toEqual({ p_processed: 0, p_oldest_message_age: "60.000 seconds", p_dead_lettered: 0 });
  });

  it("sends a cancelled invoice (docstatus 2) as cancelled", async () => {
    const cancelled = doc(1);
    cancelled.docstatus = 2;
    const { rpc, calls } = fakeRpc([queued(recordMessage(cancelled), 1)]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result.cancelled).toBe(1);
    expect(applied(calls)[0]).toMatchObject({ kind: "cancelled", sourceVersion: "2|2026-10-17 20:39:08.378782" });
  });

  it("turns an ERPNext tombstone into cancelled and a Source B tombstone into removed, without a candidate", async () => {
    const { rpc, calls } = fakeRpc([
      queued({ v: 1, kind: "tombstone", source: "erpnext", sourceDocId: "ACC-SINV-2026-00009", sourceVersion: "3|2026-10-18 14:00:00.000000", rawRef: "r" }, 1),
      queued({ v: 1, kind: "tombstone", source: "legacy_unit_b", sourceDocId: "UB-26001", sourceVersion: "2026-10-17" }, 2),
    ]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result).toMatchObject({ cancelled: 1, removed: 1, failed: 0 });
    expect(applied(calls)).toEqual([
      expect.objectContaining({ kind: "cancelled", source: "erpnext", sourceVersion: "3|2026-10-18 14:00:00.000000", candidate: null }),
      expect.objectContaining({ kind: "removed", source: "legacy_unit_b", sourceVersion: "2026-10-17", candidate: null }),
    ]);
  });

  it("validates a Source B candidate directly and resolves its customer through a normalized Unit B alias (BR05)", async () => {
    const candidate = {
      source: "legacy_unit_b", sourceDocId: "UB-26022", sourceVersion: "2026-10-16", rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
      sourceCustomer: "Blue  Ridge Kitchens, LLC", invoiceDate: "2026-02-03", currency: "USD", isCreditNote: false, status: "final", netTotal: 5,
      lines: [{ lineNo: 1, itemCode: null, description: null, qty: 1, unitPrice: 5, netAmount: 5 }], parseIssues: [],
    };
    const message = { v: 1, kind: "record", source: "legacy_unit_b", sourceDocId: "UB-26022", sourceVersion: "2026-10-16", rawRef: candidate.rawRef, candidate };
    const { rpc, calls } = fakeRpc([queued(message, 1)]);
    const loadCustomers = async () =>
      buildCustomerIndex(9, [
        { source: "erpnext", matchKey: "Blue Ridge Kitchens", canonicalId: "blue-ridge-kitchens" },
        { source: "legacy_unit_b", matchKey: "Blue Ridge Kitchens LLC", canonicalId: "blue-ridge-kitchens" },
      ]);
    expect(await processBatch({ rpc, now: NOW, loadCustomers })).toMatchObject({ valid: 1, invalid: 0, failed: 0 });
    expect(applied(calls)[0]).toMatchObject({
      kind: "valid",
      source: "legacy_unit_b",
      canonicalCustomerId: "blue-ridge-kitchens",
      mappingVersion: 9,
      candidate: { sourceDocId: "UB-26022", sourceCustomer: "Blue  Ridge Kitchens, LLC" },
    });
  });

  it("quarantines a Source B customer listed only as an ERPNext ID as UNKNOWN_CUSTOMER (BR05)", async () => {
    const candidate = {
      source: "legacy_unit_b", sourceDocId: "UB-26022", sourceVersion: "2026-10-16", rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
      sourceCustomer: "Blue Ridge Kitchens", invoiceDate: "2026-02-03", currency: "USD", isCreditNote: false, status: "final", netTotal: 5,
      lines: [{ lineNo: 1, itemCode: null, description: null, qty: 1, unitPrice: 5, netAmount: 5 }], parseIssues: [],
    };
    const message = { v: 1, kind: "record", source: "legacy_unit_b", sourceDocId: "UB-26022", sourceVersion: "2026-10-16", rawRef: candidate.rawRef, candidate };
    const { rpc, calls } = fakeRpc([queued(message, 1)]);
    // The fake mapping lists "Blue Ridge Kitchens" only as an ERPNext ID, so Source B can't use it (BR05).
    expect((await processBatch({ rpc, now: NOW })).invalid).toBe(1);
    expect(applied(calls)[0]).toMatchObject({ kind: "invalid", reasonCode: "UNKNOWN_CUSTOMER", candidate: { sourceDocId: "UB-26022" } });
  });

  describe("webhook hints (PLAN \"Source A: webhooks\")", () => {
    const hint = (name = "ACC-SINV-2026-00001") => ({ v: 1, kind: "hint", source: "erpnext", sourceDocId: name });
    const asRecord = (d: ErpInvoiceDoc) => ({ outcome: "record", message: recordMessage(d) }) as HintResolution;

    it("resolves a hint to the current document and applies it as a normal ERPNext record", async () => {
      const { rpc, calls } = fakeRpc([queued(hint(), 7)]);
      const resolveHint = jest.fn(async (_name: string) => asRecord(doc(0)));
      const result = await processBatch({ rpc, now: NOW, resolveHint });
      expect(resolveHint).toHaveBeenCalledWith("ACC-SINV-2026-00001");
      expect(result).toMatchObject({ valid: 1, skipped: 0, failed: 0 });
      expect(applied(calls)[0]).toMatchObject({ kind: "valid", sourceDocId: "ACC-SINV-2026-00001", sourceVersion: "1|2026-10-17 20:39:07.886022", canonicalCustomerId: "blue-ridge-kitchens" });
      expect(calls.find((c) => c.fn === "apply_record")?.args["p_msg_id"]).toBe(7);
    });

    it.each([
      ["a draft or another company's invoice (skip)", { outcome: "skip", reason: "docstatus 0" }],
      ["a deleted document (gone)", { outcome: "gone" }],
    ])("deletes the hint for %s without applying anything", async (_label, resolution) => {
      const { rpc, calls } = fakeRpc([queued(hint(), 7)]);
      const result = await processBatch({ rpc, now: NOW, resolveHint: async () => resolution as HintResolution });
      expect(result).toMatchObject({ skipped: 1, failed: 0 });
      expect(applied(calls)).toEqual([]);
      expect(calls.filter((c) => c.fn === "ack_invoice_event").map((c) => c.args)).toEqual([{ p_msg_id: 7 }]);
    });

    it("deletes the hint when ERPNext is unavailable, and drops the batch's other hints without calling it again", async () => {
      const { rpc, calls } = fakeRpc([queued(hint("A"), 1), queued(hint("B"), 2), queued(recordMessage(doc(0)), 3)]);
      const resolveHint = jest.fn(async (_name: string): Promise<HintResolution> => {
        throw new SourceUnavailableError("GET failed after 2 attempts");
      });
      const result = await processBatch({ rpc, now: NOW, resolveHint });
      expect(resolveHint).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ skipped: 2, valid: 1, failed: 0 });
      expect(calls.filter((c) => c.fn === "ack_invoice_event").map((c) => c.args["p_msg_id"])).toEqual([1, 2]);
      expect(vtCalls(calls)).toEqual([]);
    });

    it("drops hints once the run is past the hint budget, so a slow ERPNext can't exceed the wall-clock limit", async () => {
      const { rpc, calls } = fakeRpc([queued(hint("A"), 1), queued(hint("B"), 2)]);
      let t = Date.parse("2026-10-18T12:01:00Z");
      const now = () => new Date(t);
      const resolveHint = jest.fn(async (_name: string) => {
        t += HINT_BUDGET_MS; // this fetch used up the whole budget
        return { outcome: "skip", reason: "docstatus 0" } as HintResolution;
      });
      const result = await processBatch({ rpc, now, resolveHint });
      expect(resolveHint).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ skipped: 2, failed: 0 });
      expect(calls.filter((c) => c.fn === "ack_invoice_event").map((c) => c.args["p_msg_id"])).toEqual([1, 2]);
    });

    it("retries with backoff (no delete) on any other failure, such as the raw upload", async () => {
      const { rpc, calls } = fakeRpc([queued(hint(), 7)]);
      const result = await processBatch({ rpc, now: NOW, resolveHint: async () => Promise.reject(new Error("raw upload failed")) });
      expect(result).toMatchObject({ failed: 1, skipped: 0 });
      expect(calls.some((c) => c.fn === "ack_invoice_event")).toBe(false);
      expect(vtCalls(calls)).toEqual([{ msgId: 7, seconds: 30 }]);
    });

    it("fails (and retries) when no resolver is configured", async () => {
      const { rpc, calls } = fakeRpc([queued(hint(), 7)]);
      expect(await processBatch({ rpc, now: NOW })).toMatchObject({ failed: 1 });
      expect(calls.some((c) => c.fn === "ack_invoice_event")).toBe(false);
    });

    it("fails when the resolver answers with another invoice or a draft version", async () => {
      const other = doc(1);
      const draft = { ...doc(0), docstatus: 0 } as ErpInvoiceDoc;
      for (const resolution of [asRecord(other), { outcome: "record", message: { ...recordMessage(draft), sourceVersion: "1|2026-10-17 20:39:07.886022" } } as HintResolution]) {
        const { rpc, calls } = fakeRpc([queued(hint(), 7)]);
        expect(await processBatch({ rpc, now: NOW, resolveHint: async () => resolution })).toMatchObject({ failed: 1 });
        expect(applied(calls)).toEqual([]);
      }
    });
  });

  describe("revalidate (R15)", () => {
    const revalidate = { v: 1, kind: "revalidate", source: "erpnext", sourceDocId: "ACC-SINV-2026-00001" };

    it("re-validates the stored candidate with the current mapping, at the same version", async () => {
      const stored = { location: "quarantine", candidate: { ...decideFromDoc(), sourceCustomer: "Blue Ridge Kitchens" } };
      const { rpc, calls } = fakeRpc([queued(revalidate, 3)], { stored });
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ valid: 1, failed: 0 });
      expect(calls.find((c) => c.fn === "load_stored_record")?.args).toEqual({ p_source: "erpnext", p_source_doc_id: "ACC-SINV-2026-00001" });
      expect(applied(calls)[0]).toMatchObject({
        kind: "valid",
        sourceVersion: "1|2026-10-17 20:39:07.886022",
        mappingVersion: 4,
        canonicalCustomerId: "blue-ridge-kitchens",
      });
    });

    it("sends a stored invoice whose customer left the mapping to quarantine", async () => {
      const stored = { location: "invoice", candidate: { ...decideFromDoc(), sourceCustomer: "Gone Customer" } };
      const { rpc, calls } = fakeRpc([queued(revalidate, 3)], { stored });
      expect((await processBatch({ rpc, now: NOW })).invalid).toBe(1);
      expect(applied(calls)[0]).toMatchObject({ kind: "invalid", reasonCode: "UNKNOWN_CUSTOMER" });
    });

    it("acknowledges the message when nothing is stored for the key", async () => {
      const { rpc, calls } = fakeRpc([queued(revalidate, 3)]);
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ skipped: 1, failed: 0 });
      expect(applied(calls)).toHaveLength(0);
      expect(calls.find((c) => c.fn === "ack_invoice_event")?.args).toEqual({ p_msg_id: 3 });
      expect(calls.at(-1)?.args["p_processed"]).toBe(1);
    });

    it("fails (and retries) when the stored candidate belongs to another record", async () => {
      const stored = { location: "invoice", candidate: { ...decideFromDoc(), sourceDocId: "OTHER" } };
      const { rpc } = fakeRpc([queued(revalidate, 3)], { stored });
      expect((await processBatch({ rpc, now: NOW })).failed).toBe(1);
    });
  });

  it("counts a stale apply", async () => {
    const { rpc } = fakeRpc([queued(recordMessage(doc(0)), 1)]);
    const stale: RpcClient = {
      rpc: (fn, args) => (fn === "apply_record" ? Promise.resolve({ data: "stale", error: null }) : rpc.rpc(fn, args)),
    };
    expect((await processBatch({ rpc: stale, now: NOW })).stale).toBe(1);
  });

  it("backs off a malformed message by 30 s × 2^(attempts − 1) without applying it", async () => {
    const { rpc, calls } = fakeRpc([queued({ v: 1, kind: "record" }, 7)], { attempts: { 7: 2 } });
    const result = await processBatch({ rpc, now: NOW });
    expect(result).toMatchObject({ read: 1, failed: 1, valid: 0 });
    expect(applied(calls)).toHaveLength(0);
    expect(vtCalls(calls)).toEqual([{ msgId: 7, seconds: 120 }]); // third attempt
  });

  it("isolates failures: one bad message doesn't stop the others", async () => {
    const docs = fixtureDocs();
    const { rpc, calls } = fakeRpc(
      [queued(recordMessage(docs[0]!), 1), queued("not json object", 2), queued(recordMessage(docs[1]!), 3), queued(recordMessage(docs[2]!), 4)],
      { failApplyFor: [3] },
    );
    const result = await processBatch({ rpc, now: NOW });
    expect(result).toMatchObject({ read: 4, valid: 2, failed: 2 });
    expect(vtCalls(calls)).toEqual([
      { msgId: 2, seconds: 30 },
      { msgId: 3, seconds: 30 },
    ]);
    expect(calls.at(-1)?.args["p_processed"]).toBe(2);
  });

  describe("dead-letter queue (R13, Q4)", () => {
    const dlqCalls = (calls: Call[]) => calls.filter((c) => c.fn === "dead_letter_message").map((c) => c.args);

    it("backs off a failure on attempts 1 to 4", async () => {
      const { rpc, calls } = fakeRpc([queued({ v: 1, kind: "record" }, 7)], { attempts: { 7: 3 } });
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ failed: 1, deadLettered: 0 });
      expect(dlqCalls(calls)).toEqual([]);
      expect(vtCalls(calls)).toEqual([{ msgId: 7, seconds: 240 }]);
    });

    it("moves a message whose 5th attempt fails, with the error, and counts it in the heartbeat", async () => {
      const { rpc, calls } = fakeRpc([queued({ v: 1, kind: "record" }, 7)], { attempts: { 7: 4 } });
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ failed: 1, deadLettered: 1 });
      expect(dlqCalls(calls)).toEqual([{ p_msg_id: 7, p_error: expect.stringMatching(/source/) }]);
      expect(vtCalls(calls)).toEqual([]);
      expect(calls.at(-1)?.args["p_dead_lettered"]).toBe(1);
    });

    it("moves a message that comes back past 5 attempts without trying it again", async () => {
      const { rpc, calls } = fakeRpc([queued(recordMessage(doc(0)), 9)], { attempts: { 9: 5 } });
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ deadLettered: 1, valid: 0, failed: 0 });
      expect(applied(calls)).toHaveLength(0);
      expect(dlqCalls(calls)).toEqual([{ p_msg_id: 9, p_error: "exceeded 5 attempts without completing" }]);
    });

    it("falls back to the capped backoff when the move itself fails", async () => {
      const { rpc, calls } = fakeRpc([queued({ v: 1, kind: "record" }, 7)], { attempts: { 7: 4 }, deadLetterResult: null });
      const result = await processBatch({ rpc, now: NOW });
      expect(result).toMatchObject({ failed: 1, deadLettered: 0 });
      expect(vtCalls(calls)).toEqual([{ msgId: 7, seconds: 480 }]);
    });

    it("doesn't count a message another run already took", async () => {
      const { rpc } = fakeRpc([queued(recordMessage(doc(0)), 9)], { attempts: { 9: 5 }, deadLetterResult: "missing" });
      expect((await processBatch({ rpc, now: NOW })).deadLettered).toBe(0);
    });
  });

  it("never sends a draft (docstatus 0) to apply_record (AC06)", async () => {
    const draft = doc(0);
    draft.docstatus = 0;
    const { rpc, calls } = fakeRpc([queued(recordMessage(draft), 1)]);
    const result = await processBatch({ rpc, now: NOW });
    expect(result).toMatchObject({ failed: 1, valid: 0 });
    expect(applied(calls)).toHaveLength(0);
  });

  it.each([["an unknown string", "applied"], ["null", null], ["a number", 1]])(
    "flags apply_record returning %s as a failure and backs the message off",
    async (_label, value) => {
      const { rpc, calls } = fakeRpc([queued(recordMessage(doc(0)), 5)]);
      const odd: RpcClient = {
        async rpc(fn, args) {
          const real = await rpc.rpc(fn, args);
          return fn === "apply_record" ? { data: value, error: null } : real;
        },
      };
      const result = await processBatch({ rpc: odd, now: NOW });
      expect(result).toMatchObject({ read: 1, valid: 0, invalid: 0, cancelled: 0, stale: 0, failed: 1 });
      expect(vtCalls(calls)).toEqual([{ msgId: 5, seconds: 30 }]);
      expect(calls.at(-1)?.args["p_processed"]).toBe(0);
    },
  );

  it("fails the batch when the read itself fails", async () => {
    const rpc: RpcClient = { rpc: async () => ({ data: null, error: { message: "db down" } }) };
    await expect(processBatch({ rpc, now: NOW })).rejects.toThrow("read_invoice_events failed: db down");
  });

  describe("AC03 test switch consumer_throw_after_3", () => {
    const five = () => fixtureDocs().map((d, i) => queued(recordMessage(d), i + 1));

    it("crashes after the 3rd message and leaves the rest untouched for redelivery", async () => {
      const { rpc, calls } = fakeRpc(five());
      const asked: string[] = [];
      const testSwitch = async (name: string) => {
        asked.push(name);
        return true;
      };
      await expect(processBatch({ rpc, now: NOW, testSwitch })).rejects.toBeInstanceOf(TestSwitchCrash);
      expect(asked).toEqual(["consumer_throw_after_3"]);
      expect(applied(calls).map((o) => o.sourceDocId)).toEqual(["ACC-SINV-2026-00001", "ACC-SINV-2026-00002", "ACC-SINV-2026-00003"]);
      // Messages 4 and 5: not started, not backed off; they reappear when the 180 s visibility runs out.
      expect(calls.filter((c) => c.fn === "begin_attempt").map((c) => c.args["p_msg_id"])).toEqual([1, 2, 3]);
      expect(vtCalls(calls)).toEqual([]);
      expect(calls.some((c) => c.fn === "write_consumer_heartbeat")).toBe(false);
    });

    it("is ignored when test switches are not enabled (no lookup injected)", async () => {
      const { rpc } = fakeRpc(five());
      expect((await processBatch({ rpc, now: NOW })).valid).toBe(5);
    });

    it("does nothing when the switch is off", async () => {
      const { rpc } = fakeRpc(five());
      expect((await processBatch({ rpc, now: NOW, testSwitch: async () => false })).valid).toBe(5);
    });
  });
});

describe("parseMessage", () => {
  const good = () => recordMessage(doc(0));

  it("accepts the T6 record shape", () => {
    expect(parseMessage(good()).sourceDocId).toBe("ACC-SINV-2026-00001");
  });

  it("accepts the enqueue_hint shape", () => {
    expect(parseMessage({ v: 1, kind: "hint", source: "erpnext", sourceDocId: "ACC-SINV-2026-00001" })).toEqual({
      v: 1, kind: "hint", source: "erpnext", sourceDocId: "ACC-SINV-2026-00001",
    });
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["another version", { ...good(), v: 2 }],
    ["a hint with record fields", { ...good(), kind: "hint" }],
    ["a hint from Source B", { v: 1, kind: "hint", source: "legacy_unit_b", sourceDocId: "UB-1" }],
    ["another source", { ...good(), source: "legacy_unit_b" }],
    ["no sourceDocId", { ...good(), sourceDocId: "" }],
    ["a draft version", { ...good(), sourceVersion: "0|2026-10-17 20:39:07.886022" }],
    ["a short version", { ...good(), sourceVersion: "1|2026-10-17 20:39:07" }],
    ["no rawRef", { ...good(), rawRef: 3 }],
    ["no doc", { ...good(), doc: "x" }],
    ["a doc of another invoice", { ...good(), sourceDocId: "ACC-SINV-2026-00999" }],
    ["a doc of another version", { ...good(), sourceVersion: "2|2026-10-17 20:39:07.886022" }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseMessage(raw)).toThrow(MalformedMessageError);
  });
});

describe("backoffSeconds", () => {
  it("doubles from 30 s and caps at 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480, 900, 900, 900]);
  });
});

describe("describeReason", () => {
  it("shows money with two decimals in a TOTAL_MISMATCH detail", () => {
    const candidate = {
      source: "legacy_unit_b",
      sourceDocId: "UB-26077",
      sourceVersion: "2026-10-16",
      rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
      sourceCustomer: "Harbor Ln. Bistro",
      invoiceDate: "2026-10-11",
      currency: "USD",
      isCreditNote: false,
      status: "final",
      netTotal: 2408.8,
      lines: [
        { lineNo: 1, itemCode: null, description: "BEANS BLACK #10 CS", qty: 46, unitPrice: 32.4, netAmount: 1490.4 },
        { lineNo: 2, itemCode: null, description: "PASTA PENNE 20LB", qty: 31, unitPrice: 26.4, netAmount: 818.4 },
      ],
      parseIssues: [],
    } as const satisfies CanonicalCandidate;
    expect(describeReason("TOTAL_MISMATCH", candidate)).toBe("Net total 2408.80 differs from the sum of lines 2308.80");
  });
});
