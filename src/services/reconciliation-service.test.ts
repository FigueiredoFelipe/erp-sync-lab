import { describe, expect, it } from "@jest/globals";
import type { ErpSubmittedDoc } from "../core/adapters/erpnext/adapter.ts";
import { jsonResponse, scriptedFetch } from "../core/adapters/erpnext/test-helpers.ts";
import { classify, reconcile, runReconciliation, type StoreSnapshot } from "./reconciliation-service.ts";
import type { RpcClient } from "./poll-service.ts";

// T16: reconciliation of Source A (R14, AC05).

const CURSOR = { modified: "2026-10-18 09:00:00.000000", name: "ACC-SINV-2026-00050" };

function doc(name: string, amount: number, modified = "2026-10-17 12:00:00.000000", postingDate = "2026-03-10"): ErpSubmittedDoc {
  return { name, modified, postingDate, baseNetTotal: amount };
}

function snapshot(partial: Partial<StoreSnapshot> = {}): StoreSnapshot {
  return { cursor: CURSOR, invoices: [], pending: [], quarantined: [], deadLettered: [], ...partial };
}

const none = new Set<string>();
const ctx = (over: Partial<Parameters<typeof classify>[1]> = {}) => ({ cursor: CURSOR, pending: none, quarantined: none, deadLettered: none, ...over });

describe("classify (first match wins)", () => {
  it("in_flight when ERPNext modified it after the invoices cursor", () => {
    expect(classify({ name: "A", modified: "2026-10-18 09:00:00.000001" }, ctx())).toBe("in_flight");
  });

  it("uses the name to break a tie on modified, like the poll's keyset", () => {
    expect(classify({ name: "ACC-SINV-2026-00051", modified: CURSOR.modified }, ctx())).toBe("in_flight");
    expect(classify({ name: "ACC-SINV-2026-00049", modified: CURSOR.modified }, ctx())).toBe("unexplained");
  });

  it("in_flight when a message for it is still queued, even if quarantined", () => {
    expect(classify({ name: "A", modified: null }, ctx({ pending: new Set(["A"]), quarantined: new Set(["A"]) }))).toBe("in_flight");
  });

  it("in_flight for everything before the first sync (no cursor)", () => {
    expect(classify({ name: "A", modified: "2026-01-01 00:00:00.000000" }, ctx({ cursor: null }))).toBe("in_flight");
  });

  it("quarantined before dead_lettered", () => {
    expect(classify({ name: "A", modified: null }, ctx({ quarantined: new Set(["A"]), deadLettered: new Set(["A"]) }))).toBe("quarantined");
    expect(classify({ name: "A", modified: null }, ctx({ deadLettered: new Set(["A"]) }))).toBe("dead_lettered");
  });

  it("unexplained otherwise", () => {
    expect(classify({ name: "A", modified: "2026-10-17 00:00:00.000000" }, ctx())).toBe("unexplained");
  });
});

describe("reconcile", () => {
  it("AC05: equal stores give no difference, only month summaries", () => {
    const r = reconcile([doc("A", 100.1), doc("B", 50, undefined, "2026-04-02")], snapshot({
      invoices: [
        { id: "A", amount: "100.10", invoiceDate: "2026-03-10" },
        { id: "B", amount: "50.00", invoiceDate: "2026-04-02" },
      ],
    }));
    expect(r).toEqual({
      rows: [
        { month: "2026-03-01", sourceDocId: null, erpAmount: "100.10", storedAmount: "100.10", class: "summary" },
        { month: "2026-04-01", sourceDocId: null, erpAmount: "50.00", storedAmount: "50.00", class: "summary" },
      ],
      erpTotal: "150.10",
      storedTotal: "150.10",
      unexplained: 0,
    });
  });

  it("an invoice row deleted by hand from the store is unexplained", () => {
    const r = reconcile([doc("A", 100), doc("B", 25)], snapshot({ invoices: [{ id: "A", amount: "100.00", invoiceDate: "2026-03-10" }] }));
    expect(r.unexplained).toBe(1);
    expect(r.rows).toContainEqual({ month: "2026-03-01", sourceDocId: "B", erpAmount: "25.00", storedAmount: "0.00", class: "unexplained" });
    expect(r.rows).toContainEqual({ month: "2026-03-01", sourceDocId: null, erpAmount: "125.00", storedAmount: "100.00", class: "summary" });
  });

  it("explains missing documents that are quarantined, dead-lettered or in flight", () => {
    const r = reconcile([doc("Q", 1), doc("D", 2), doc("P", 3), doc("N", 4, "2026-10-18 10:00:00.000000")], snapshot({
      quarantined: ["Q"],
      deadLettered: ["D"],
      pending: ["P"],
    }));
    const classes = Object.fromEntries(r.rows.filter((x) => x.sourceDocId).map((x) => [x.sourceDocId, x.class]));
    expect(classes).toEqual({ Q: "quarantined", D: "dead_lettered", P: "in_flight", N: "in_flight" });
    expect(r.unexplained).toBe(0);
  });

  it("compares amounts in cents: a one-cent difference is a difference", () => {
    const r = reconcile([doc("A", 100.01)], snapshot({ invoices: [{ id: "A", amount: "100.00", invoiceDate: "2026-03-10" }] }));
    expect(r.rows.filter((x) => x.sourceDocId)).toEqual([{ month: "2026-03-01", sourceDocId: "A", erpAmount: "100.01", storedAmount: "100.00", class: "unexplained" }]);
  });

  it("a stored invoice no longer submitted in ERPNext (cancelled) differs against 0", () => {
    const stored = snapshot({ invoices: [{ id: "C", amount: "80.00", invoiceDate: "2026-05-05" }] });
    expect(reconcile([], stored).rows).toContainEqual({ month: "2026-05-01", sourceDocId: "C", erpAmount: "0.00", storedAmount: "80.00", class: "unexplained" });
    expect(reconcile([], { ...stored, pending: ["C"] }).unexplained).toBe(0);
  });

  it("credit notes keep their sign in both totals", () => {
    const r = reconcile([doc("R", -40)], snapshot({ invoices: [{ id: "R", amount: "-40.00", invoiceDate: "2026-03-10" }] }));
    expect(r).toMatchObject({ erpTotal: "-40.00", storedTotal: "-40.00", unexplained: 0 });
  });
});

// In-memory stand-in for the reconciliation wrappers.
class FakeDb implements RpcClient {
  readonly calls: { fn: string; args: Record<string, unknown> }[] = [];
  snap: StoreSnapshot = snapshot();
  async rpc(fn: string, args: object) {
    this.calls.push({ fn, args: args as Record<string, unknown> });
    switch (fn) {
      case "start_reconciliation_run":
        return { data: "run-1", error: null };
      case "reconciliation_snapshot":
        return { data: this.snap, error: null };
      case "finish_reconciliation_run":
        return { data: null, error: null };
      default:
        return { data: null, error: { message: `unknown ${fn}` } };
    }
  }
  finish() {
    return this.calls.find((c) => c.fn === "finish_reconciliation_run")!.args;
  }
}

const ERP = { baseUrl: "https://erp.example.test", apiKey: "k", apiSecret: "s" };
const erpRow = (name: string, total: number) => ({ name, modified: "2026-10-17 12:00:00.5", posting_date: "2026-03-10", base_net_total: total });

describe("runReconciliation", () => {
  it("reads the snapshot before ERPNext, pages by name, and records a succeeded run", async () => {
    const db = new FakeDb();
    db.snap = snapshot({ invoices: [{ id: "A", amount: "10.00", invoiceDate: "2026-03-10" }] });
    const { fetch, calls } = scriptedFetch([jsonResponse({ data: [erpRow("A", 10), erpRow("B", 5)] }), jsonResponse({ data: [] })]);
    const order: string[] = [];
    const rpc: RpcClient = { rpc: (fn, args) => (order.push(fn), db.rpc(fn, args)) };
    const tracked = (async (input: string | URL | Request, init?: RequestInit) => (order.push("erp"), fetch(input, init))) as typeof globalThis.fetch;

    const result = await runReconciliation({ rpc, erpnext: ERP, fetch: tracked, period: { from: "2026-01-01", to: "2026-12-31" } });
    expect(order.slice(0, 3)).toEqual(["start_reconciliation_run", "reconciliation_snapshot", "erp"]);
    expect(result).toEqual({ runId: "run-1", status: "succeeded", erpTotal: "15.00", storedTotal: "10.00", unexplained: 1, differences: 1 });
    expect(db.finish()).toMatchObject({ p_id: "run-1", p_status: "succeeded", p_erp_total: "15.00", p_stored_total: "10.00", p_unexplained: 1, p_error: null });
    expect(db.finish()["p_results"]).toContainEqual({ month: "2026-03-01", sourceDocId: "B", erpAmount: "5.00", storedAmount: "0.00", class: "unexplained" });

    const url = new URL(calls[0]!.url);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      ["company", "=", "Harvest Table Foods"],
      ["docstatus", "=", 1],
      ["posting_date", ">=", "2026-01-01"],
      ["posting_date", "<=", "2026-12-31"],
      ["name", ">", ""],
    ]);
    expect(JSON.parse(url.searchParams.get("fields")!)).toEqual(["name", "modified", "posting_date", "base_net_total"]);
    expect(url.searchParams.get("order_by")).toBe("name asc");
  });

  it("follows full pages with a name keyset", async () => {
    const db = new FakeDb();
    const full = Array.from({ length: 500 }, (_, i) => erpRow(`N${String(i).padStart(4, "0")}`, 1));
    const { fetch, calls } = scriptedFetch([jsonResponse({ data: full }), jsonResponse({ data: [erpRow("N9999", 1)] })]);
    const result = await runReconciliation({ rpc: db, erpnext: ERP, fetch });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(new URL(calls[1]!.url).searchParams.get("filters")!)).toContainEqual(["name", ">", "N0499"]);
    expect(result.erpTotal).toBe("501.00");
  });

  it("records a failed run when ERPNext is down, with no results", async () => {
    const db = new FakeDb();
    const { fetch } = scriptedFetch([jsonResponse({}, 502), jsonResponse({}, 502)]);
    const result = await runReconciliation({ rpc: db, erpnext: ERP, fetch, sleep: async () => {} });
    expect(result).toMatchObject({ status: "failed", unexplained: null, error: expect.stringMatching(/after 2 attempts/) });
    expect(db.finish()).toMatchObject({ p_status: "failed", p_results: [], p_erp_total: null });
  });

  it("throws when the run can't be opened", async () => {
    const rpc: RpcClient = { rpc: async () => ({ data: null, error: { message: "db down" } }) };
    await expect(runReconciliation({ rpc, erpnext: ERP, fetch: scriptedFetch([]).fetch })).rejects.toThrow(/start_reconciliation_run failed: db down/);
  });
});
