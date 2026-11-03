import { describe, expect, it } from "@jest/globals";
import type { ErpInvoiceDoc } from "../core/adapters/erpnext/adapter.ts";
import { jsonResponse, loadFixture, scriptedFetch, type ScriptedReply } from "../core/adapters/erpnext/test-helpers.ts";
import type { ErpDeletedDoc } from "../core/adapters/erpnext/adapter.ts";
import {
  combineResults,
  DELETED_BUDGET_MS,
  ERP_HTTP_LIMITS,
  rawPathOf,
  RUN_BUDGET_MS,
  runErpnextPoll,
  tombstoneFor,
  toRecordMessage,
  toTombstoneMessage,
  type RpcClient,
} from "./poll-service.ts";

// T6: pollService with a fake database (an in-memory model of the public wrappers) and a scripted ERPNext.

type Call = { fn: string; args: Record<string, unknown> };

// In-memory stand-in for the SQL wrappers: enough behaviour to drive IncrementalSync end to end.
class FakeDb implements RpcClient {
  readonly calls: Call[] = [];
  readonly cursors = new Map<string, { modified: string; name: string }>();
  lastStatus: string | null = null;
  readonly enqueuedVersion = new Map<string, string>();
  readonly queue: unknown[] = [];
  failOn: string | null = null;

  async rpc(fn: string, args: object) {
    const a = args as Record<string, unknown>;
    this.calls.push({ fn, args: a });
    if (fn === this.failOn) return { data: null, error: { message: "boom" } };
    switch (fn) {
      case "start_sync_run":
        return { data: "run-1", error: null };
      case "last_sync_run_status":
        return { data: this.lastStatus, error: null };
      case "read_sync_cursor": {
        const c = this.cursors.get(a["p_stream"] as string);
        return { data: c ? [c] : [], error: null };
      }
      case "enqueue_page": {
        let sent = 0;
        for (const m of a["p_messages"] as { sourceDocId: string; sourceVersion: string }[]) {
          const prev = this.enqueuedVersion.get(m.sourceDocId);
          if (prev !== undefined && m.sourceVersion <= prev) continue;
          this.enqueuedVersion.set(m.sourceDocId, m.sourceVersion);
          this.queue.push(m);
          sent++;
        }
        this.cursors.set(a["p_stream"] as string, { modified: a["p_last_modified"] as string, name: a["p_last_name"] as string });
        return { data: sent, error: null };
      }
      case "finish_sync_run":
        this.lastStatus = a["p_status"] as string;
        return { data: null, error: null };
      default:
        return { data: null, error: { message: `unknown function ${fn}` } };
    }
  }

  argsOf(fn: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args);
  }
}

const page1 = loadFixture<{ data: ErpInvoiceDoc[] }>("changed-page-1.json");
const ERP = { baseUrl: "https://erp.example.test", apiKey: "k", apiSecret: "s" };

const EMPTY = () => jsonResponse({ data: [] });

// Routes each ERPNext call by doctype: Sales Invoice replies come from `invoiceReplies`, Deleted Document
// replies from `deletedReplies` (an empty page when none is scripted).
function routedFetch(invoiceReplies: ScriptedReply[], deletedReplies: ScriptedReply[] = []) {
  const invoices = scriptedFetch(invoiceReplies);
  const deleted = scriptedFetch(deletedReplies);
  const all: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    all.push({ url: String(input), init });
    if (String(input).includes("/Deleted%20Document")) {
      return deleted.calls.length < deletedReplies.length ? deleted.fetch(input, init) : EMPTY();
    }
    return invoices.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls: invoices.calls, deletedCalls: deleted.calls, all };
}

function setup(replies: ScriptedReply[], deletedReplies: ScriptedReply[] = []) {
  const db = new FakeDb();
  const raw = new Map<string, string>();
  const { fetch, calls, deletedCalls, all } = routedFetch(replies, deletedReplies);
  const sleeps: number[] = [];
  const deps = {
    rpc: db,
    putRaw: async (path: string, json: string) => {
      raw.set(path, json);
    },
    erpnext: ERP,
    fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    clock: { nowMs: () => 0 },
  };
  return { db, raw, fetchCalls: calls, deletedCalls, allCalls: all, sleeps, run: () => runErpnextPoll(deps) };
}

describe("queue message", () => {
  it("has exactly the shape invoice-consumer relies on", () => {
    const doc = page1.data[0]!;
    expect(toRecordMessage(doc)).toStrictEqual({
      v: 1,
      kind: "record",
      source: "erpnext",
      sourceDocId: "ACC-SINV-2026-00001",
      sourceVersion: "1|2026-10-17 20:39:07.886022",
      rawRef: "erpnext/ACC-SINV-2026-00001/1-2026-10-17 20:39:07.886022.json",
      doc,
    });
  });

  it("uses a fixed-width modified in the version and the raw path", () => {
    const doc: ErpInvoiceDoc = { ...page1.data[0]!, docstatus: 2, modified: "2026-10-18 09:00:01.5" };
    expect(toRecordMessage(doc).sourceVersion).toBe("2|2026-10-18 09:00:01.500000");
    expect(rawPathOf(doc)).toBe("erpnext/ACC-SINV-2026-00001/2-2026-10-18 09:00:01.500000.json");
  });
});

describe("runErpnextPoll", () => {
  it("enqueues every fetched invoice, writes its raw JSON and logs the run", async () => {
    const t = setup([jsonResponse(page1)]);
    // Page size is 100, so a 3-doc page is short and ends the run.
    const first = await t.run();
    expect(first).toEqual({ status: "succeeded", pages: 1, fetched: 3, enqueued: 3 });

    // An empty deleted page commits nothing, so the only commit is the invoices page.
    expect(t.db.argsOf("enqueue_page")).toHaveLength(1);
    const [invoicePage] = t.db.argsOf("enqueue_page");
    expect(invoicePage).toEqual({
      p_source: "erpnext",
      p_stream: "invoices",
      p_messages: page1.data.map(toRecordMessage),
      p_last_modified: "2026-10-17 20:39:08.776123",
      p_last_name: "ACC-SINV-2026-00003",
    });

    expect([...t.raw.keys()]).toEqual(page1.data.map(rawPathOf));
    expect(JSON.parse(t.raw.get(rawPathOf(page1.data[1]!))!)).toEqual(page1.data[1]);

    const [finish] = t.db.argsOf("finish_sync_run");
    expect(finish).toEqual({
      p_id: "run-1",
      p_status: "succeeded",
      p_pages: 1,
      p_fetched: 3,
      p_enqueued: 3,
      p_error: null,
      p_fetched_docs: [
        { name: "ACC-SINV-2026-00001", sourceVersion: "1|2026-10-17 20:39:07.886022" },
        { name: "ACC-SINV-2026-00002", sourceVersion: "1|2026-10-17 20:39:08.378782" },
        { name: "ACC-SINV-2026-00003", sourceVersion: "1|2026-10-17 20:39:08.776123" },
      ],
    });
  });

  it("starts the run before reading the cursor and finishes it last", async () => {
    const t = setup([jsonResponse(page1)]);
    await t.run();
    const order = t.db.calls.map((c) => c.fn);
    expect(order[0]).toBe("start_sync_run");
    expect(order.at(-1)).toBe("finish_sync_run");
    expect(order).toContain("read_sync_cursor");
    expect(order).toContain("last_sync_run_status");
  });

  it("asks ERPNext for the configured company only, GET only", async () => {
    const t = setup([jsonResponse({ data: [] })]);
    await t.run();
    expect(t.fetchCalls).toHaveLength(1);
    for (const c of t.allCalls) expect(c.init?.method).toBe("GET");
    const call = t.fetchCalls[0]!;
    expect(call.init?.method).toBe("GET");
    const filters = JSON.parse(new URL(call.url).searchParams.get("filters")!);
    expect(filters).toContainEqual(["company", "=", "Harvest Table Foods"]);
  });

  it("a second run over the same documents enqueues nothing", async () => {
    const t = setup([jsonResponse(page1), jsonResponse(page1)]);
    await t.run();
    const second = await t.run();
    expect(second).toEqual({ status: "succeeded", pages: 1, fetched: 3, enqueued: 0 });
    expect(t.db.queue).toHaveLength(3);
  });

  it("writes the raw JSON before enqueuing, so a message never points at a missing object", async () => {
    const t = setup([jsonResponse(page1)]);
    const order: string[] = [];
    const rpc = t.db.rpc.bind(t.db);
    t.db.rpc = async (fn: string, args: object) => {
      order.push(fn);
      return rpc(fn, args);
    };
    const result = await runErpnextPoll({
      rpc: t.db,
      putRaw: async () => {
        order.push("putRaw");
      },
      erpnext: ERP,
      fetch: routedFetch([jsonResponse(page1)]).fetch,
      clock: { nowMs: () => 0 },
    });
    expect(result.status).toBe("succeeded");
    expect(order.indexOf("enqueue_page")).toBeGreaterThan(order.lastIndexOf("putRaw"));
  });

  it("fails the run without enqueuing when a raw write fails", async () => {
    const db = new FakeDb();
    const result = await runErpnextPoll({
      rpc: db,
      putRaw: async () => {
        throw new Error("storage down");
      },
      erpnext: ERP,
      fetch: routedFetch([jsonResponse(page1)]).fetch,
      clock: { nowMs: () => 0 },
    });
    expect(result).toMatchObject({ status: "failed", error: "invoices: storage down" });
    expect(db.argsOf("enqueue_page")).toHaveLength(0);
    expect(db.argsOf("finish_sync_run")[0]).toMatchObject({ p_status: "failed", p_error: "invoices: storage down" });
  });

  it("reports a database error as a failed run", async () => {
    const t = setup([jsonResponse(page1)]);
    t.db.failOn = "enqueue_page";
    const result = await t.run();
    expect(result).toMatchObject({ status: "failed", error: "invoices: enqueue_page failed: boom" });
  });
});

describe("ERP limits (one fetch bounded to ~40 s, AC11)", () => {
  it("worst case of one fetch stays within 40 s, so 100 s budget + one fetch < 150 s", () => {
    const { timeoutMs, maxAttempts, maxDelayMs } = ERP_HTTP_LIMITS;
    const worstCase = maxAttempts * timeoutMs + (maxAttempts - 1) * maxDelayMs;
    expect(worstCase).toBeLessThanOrEqual(40_000);
    expect(100_000 + worstCase).toBeLessThan(150_000);
  });

  it("an ERPNext answering 502 fails the run after 2 attempts per stream and enqueues nothing", async () => {
    const t = setup([jsonResponse({}, 502), jsonResponse({}, 502), jsonResponse({}, 502)], [jsonResponse({}, 502), jsonResponse({}, 502)]);
    const result = await t.run();
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/^deleted: .*after 2 attempts.*; invoices: .*after 2 attempts/);
    expect(t.fetchCalls).toHaveLength(2);
    expect(t.deletedCalls).toHaveLength(2);
    expect(t.db.argsOf("enqueue_page")).toHaveLength(0);
    expect(t.db.argsOf("finish_sync_run")[0]).toMatchObject({ p_status: "failed", p_fetched_docs: [] });
  });

  it("caps a long Retry-After at 5 s", async () => {
    const t = setup([jsonResponse({}, 429, { "Retry-After": "120" }), jsonResponse(page1)]);
    const result = await t.run();
    expect(result.status).toBe("succeeded");
    expect(t.sleeps).toEqual([5_000]);
  });

  it("gives each attempt an abort signal", async () => {
    const t = setup([jsonResponse(page1)]);
    await t.run();
    expect(t.fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

// T14: the deleted stream (EC12). Rows shaped like the Deleted Document GET confirmed on 2026-10-18.
function deletedRow(name: string, deletedName: string, creation: string, data: Record<string, unknown> | string | null): ErpDeletedDoc {
  return {
    name,
    deleted_doctype: "Sales Invoice",
    deleted_name: deletedName,
    creation,
    data: data === null || typeof data === "string" ? data : JSON.stringify(data),
  };
}
const CANCELLED = { doctype: "Sales Invoice", name: "ACC-SINV-2026-00002", docstatus: 2, company: "Harvest Table Foods" };

describe("tombstone message", () => {
  it("has exactly the shape the consumer track relies on", () => {
    const row = deletedRow("24h8tuqm2k", "ACC-SINV-2026-00002", "2026-10-18 10:11:12.5", CANCELLED);
    expect(toTombstoneMessage(row)).toStrictEqual({
      v: 1,
      kind: "tombstone",
      source: "erpnext",
      sourceDocId: "ACC-SINV-2026-00002",
      sourceVersion: "3|2026-10-18 10:11:12.500000",
      rawRef: "erpnext/deleted/ACC-SINV-2026-00002.json",
    });
  });

  it("outranks any submission or cancellation version of the same invoice", () => {
    const v = toTombstoneMessage(deletedRow("x", "A", "2020-01-01 00:00:00", CANCELLED)).sourceVersion;
    expect(v > "2|9999-12-31 23:59:59.999999").toBe(true);
  });

  it("refuses a row without deleted_name", () => {
    expect(() => toTombstoneMessage({ ...deletedRow("x", "A", "2026-10-18 10:00:00", CANCELLED), deleted_name: null })).toThrow(/deleted_name/);
  });
});

describe("tombstoneFor (which deletions can have touched the figures)", () => {
  const at = "2026-10-18 10:00:00.000000";
  it("tombstones a deleted cancelled invoice of the company", () => {
    expect(tombstoneFor(deletedRow("x", "A", at, CANCELLED))?.sourceDocId).toBe("A");
  });

  it("skips a deleted draft, which never counted", () => {
    expect(tombstoneFor(deletedRow("x", "A-1", at, { ...CANCELLED, docstatus: 0 }))).toBeNull();
  });

  it("skips an invoice of another company", () => {
    expect(tombstoneFor(deletedRow("x", "A", at, { ...CANCELLED, company: "Other Co" }))).toBeNull();
  });

  it("skips a row of another doctype", () => {
    expect(tombstoneFor({ ...deletedRow("x", "A", at, CANCELLED), deleted_doctype: "Sales Order" })).toBeNull();
  });

  it.each([
    ["missing", null],
    ["unreadable", "{not json"],
    ["not an object", "[1,2]"],
  ])("tombstones when data is %s (fail-closed)", (_label, data) => {
    expect(tombstoneFor(deletedRow("x", "A", at, data))?.sourceDocId).toBe("A");
  });

  it("tombstones an unexpected docstatus or a missing company (fail-closed)", () => {
    expect(tombstoneFor(deletedRow("x", "A", at, { docstatus: 1, company: "Harvest Table Foods" }))).not.toBeNull();
    expect(tombstoneFor(deletedRow("x", "A", at, { docstatus: 2 }))).not.toBeNull();
  });
});

describe("runErpnextPoll, deleted stream", () => {
  const cancelled = deletedRow("24h0000001", "ACC-SINV-2026-00002", "2026-10-18 10:00:00.000001", CANCELLED);
  const draft = deletedRow("24h0000002", "ACC-SINV-2026-00009-1", "2026-10-18 10:00:00.000002", { ...CANCELLED, docstatus: 0 });

  it("queries Deleted Document for Sales Invoice in (creation, name) order, GET only", async () => {
    const t = setup([EMPTY()]);
    await t.run();
    const calls = t.allCalls.filter((c) => c.url.includes("/Deleted%20Document"));
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      ["deleted_doctype", "=", "Sales Invoice"],
      ["creation", ">=", "0001-01-01 00:00:00.000000"],
    ]);
    expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([
      ["creation", ">", "0001-01-01 00:00:00.000000"],
      ["name", ">", ""],
    ]);
    expect(url.searchParams.get("order_by")).toBe("creation asc, name asc");
    expect(JSON.parse(url.searchParams.get("fields")!)).toEqual(["name", "deleted_doctype", "deleted_name", "creation", "data"]);
  });

  it("enqueues a tombstone per relevant deletion, moves its own cursor past every row, and logs it", async () => {
    const t = setup([EMPTY()], [jsonResponse({ data: [cancelled, draft] })]);
    const result = await t.run();
    expect(result).toEqual({ status: "succeeded", pages: 1, fetched: 2, enqueued: 1 });
    expect(t.db.argsOf("enqueue_page")).toEqual([
      {
        p_source: "erpnext",
        p_stream: "deleted",
        p_messages: [toTombstoneMessage(cancelled)],
        p_last_modified: "2026-10-18 10:00:00.000002",
        p_last_name: "24h0000002",
      },
    ]);
    expect(t.db.cursors.get("deleted")).toEqual({ modified: "2026-10-18 10:00:00.000002", name: "24h0000002" });
    expect(t.db.cursors.get("invoices")).toBeUndefined();
    expect(JSON.parse(t.raw.get("erpnext/deleted/ACC-SINV-2026-00002.json")!)).toEqual(cancelled);
    expect(t.db.argsOf("finish_sync_run")[0]!["p_fetched_docs"]).toEqual([
      { name: "ACC-SINV-2026-00002", sourceVersion: "3|2026-10-18 10:00:00.000001" },
    ]);
  });

  it("re-reads its overlap window from its own cursor and skips tombstones already enqueued", async () => {
    const t = setup([EMPTY(), EMPTY()], [jsonResponse({ data: [cancelled] }), jsonResponse({ data: [cancelled] })]);
    await t.run();
    const second = await t.run();
    expect(second).toMatchObject({ status: "succeeded", enqueued: 0 });
    expect(t.db.queue).toHaveLength(1);
    const url = new URL(t.deletedCalls[1]!.url);
    expect(JSON.parse(url.searchParams.get("filters")!)).toContainEqual(["creation", ">=", "2026-10-18 08:55:00.000001"]);
  });

  it("EC12: an invoice synced, then cancelled and deleted between two runs, gets a tombstone that outranks its record", async () => {
    const synced = page1.data[1]!; // ACC-SINV-2026-00002, submitted
    const t = setup([jsonResponse(page1), EMPTY()], [EMPTY(), jsonResponse({ data: [cancelled] })]);
    await t.run();
    // Between the runs the invoice is cancelled and deleted: it is gone from Sales Invoice (empty page),
    // and the cancellation was never seen. Only the Deleted Document row tells.
    const second = await t.run();
    expect(second).toMatchObject({ status: "succeeded", enqueued: 1 });
    const [record, tombstone] = t.db.queue.filter((m) => (m as { sourceDocId: string }).sourceDocId === synced.name) as {
      kind: string;
      sourceVersion: string;
    }[];
    expect(record!.kind).toBe("record");
    expect(tombstone!.kind).toBe("tombstone");
    expect(tombstone!.sourceVersion > record!.sourceVersion).toBe(true);
  });

  it("a failing deleted stream fails the run but still syncs invoices", async () => {
    const t = setup([jsonResponse(page1)], [jsonResponse({}, 502), jsonResponse({}, 502)]);
    const result = await t.run();
    expect(result).toMatchObject({ status: "failed", pages: 1, fetched: 3, enqueued: 3 });
    expect(result.error).toMatch(/^deleted: /);
    expect(t.db.cursors.get("invoices")).toBeDefined();
    expect(t.db.cursors.get("deleted")).toBeUndefined();
  });

  it("caps the deleted stream and gives the invoices stream the rest of the 100 s budget", async () => {
    // Each fetch takes 15 s on this clock; full pages force the streams to keep fetching until the budget.
    let now = 0;
    const fullDeleted = (i: number) =>
      jsonResponse({ data: Array.from({ length: 100 }, (_, k) => deletedRow(`d${i}-${String(k).padStart(3, "0")}`, `X${i}-${k}`, `2026-10-18 10:00:0${i}.000000`, CANCELLED)) });
    const fullInvoices = (i: number) =>
      jsonResponse({ data: Array.from({ length: 100 }, (_, k) => ({ ...page1.data[0]!, name: `INV-${i}-${String(k).padStart(3, "0")}`, modified: `2026-10-18 11:00:0${i}.000000` })) });
    const { fetch } = routedFetch(Array.from({ length: 9 }, (_, i) => fullInvoices(i)), Array.from({ length: 9 }, (_, i) => fullDeleted(i)));
    const timed = (async (input: string | URL | Request, init?: RequestInit) => {
      now += 15_000;
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    const db = new FakeDb();
    const result = await runErpnextPoll({ rpc: db, putRaw: async () => {}, erpnext: ERP, fetch: timed, clock: { nowMs: () => now } });
    expect(result.status).toBe("incomplete");
    // deleted: fetches at 15 s and 30 s (budget 20 s reached), invoices: until 100 s total, plus one fetch.
    expect(db.argsOf("enqueue_page").filter((a) => a["p_stream"] === "deleted")).toHaveLength(2);
    expect(now).toBeLessThanOrEqual(RUN_BUDGET_MS + 15_000);
    expect(DELETED_BUDGET_MS).toBeLessThan(RUN_BUDGET_MS);
  });
});

describe("combineResults", () => {
  const ok = { status: "succeeded" as const, pages: 1, fetched: 2, enqueued: 1 };
  it("sums counts and keeps the worst status", () => {
    expect(combineResults([ok, ok])).toEqual({ status: "succeeded", pages: 2, fetched: 4, enqueued: 2 });
    expect(combineResults([ok, { ...ok, status: "incomplete" }]).status).toBe("incomplete");
    expect(combineResults([{ ...ok, status: "incomplete" }, { ...ok, status: "failed", error: "x" }])).toMatchObject({ status: "failed", error: "x" });
  });
});
