import { describe, expect, it } from "@jest/globals";
import { SourceUnavailableError } from "../../sync/contracts.ts";
import { ErpNextAdapter, normalizeModified, toCandidate, type ErpInvoiceDoc } from "./adapter.ts";
import { ErpNextHttpClient } from "./http-client.ts";
import { jsonResponse, loadFixture, scriptedFetch, type ScriptedReply } from "./test-helpers.ts";

// Recorded once with read-only GETs against the lab instance (fictitious data).
type ListResponse = { data: ErpInvoiceDoc[] };
const page1 = () => loadFixture<ListResponse>("changed-page-1.json");
const page2 = () => loadFixture<ListResponse>("changed-page-2.json");

function makeAdapter(replies: ScriptedReply[], maxAttempts = 2) {
  const scripted = scriptedFetch(replies);
  const client = new ErpNextHttpClient({
    baseUrl: "https://erp.example.test",
    apiKey: "k",
    apiSecret: "s",
    maxAttempts,
    fetch: scripted.fetch,
    sleep: async () => {},
  });
  return { adapter: new ErpNextAdapter({ client, company: "Harvest Table Foods" }), calls: scripted.calls };
}

const RAW_REF = "raw/erpnext/ACC-SINV-2026-00001/1.json";

describe("ErpNextAdapter.fetchChangedPage", () => {
  it("builds the keyset query exactly", async () => {
    const { adapter, calls } = makeAdapter([jsonResponse(page1())]);

    await adapter.fetchChangedPage({ modified: "2026-10-17 19:34:07.886022", name: "ACC-SINV-2026-00001" }, 100);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/resource/Sales%20Invoice");
    expect([...url.searchParams.keys()].sort()).toEqual(["fields", "filters", "limit", "or_filters", "order_by"]);
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
      ["company", "=", "Harvest Table Foods"],
      ["docstatus", "in", [1, 2]],
      ["modified", ">=", "2026-10-17 19:34:07.886022"],
    ]);
    expect(JSON.parse(url.searchParams.get("or_filters")!)).toEqual([
      ["modified", ">", "2026-10-17 19:34:07.886022"],
      ["name", ">", "ACC-SINV-2026-00001"],
    ]);
    expect(url.searchParams.get("order_by")).toBe("modified asc, name asc");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.has("limit_page_length")).toBe(false);
    expect(JSON.parse(url.searchParams.get("fields")!)).toEqual([
      "name",
      "docstatus",
      "modified",
      "company",
      "customer",
      "posting_date",
      "currency",
      "is_return",
      "return_against",
      "amended_from",
      "base_net_total",
      { items: ["name", "idx", "item_code", "item_name", "qty", "base_rate", "base_net_rate", "base_net_amount"] },
    ]);
    // URL-encoded on the wire: no raw spaces, brackets or quotes.
    expect(calls[0]!.url).not.toMatch(/[ \[\]"]/);
  });

  it("returns the docs with nested lines and the cursor of the last doc", async () => {
    const { adapter } = makeAdapter([jsonResponse(page1())]);

    const page = await adapter.fetchChangedPage({ modified: "1900-01-01 00:00:00.000000", name: "" }, 3);

    expect(page.docs.map((d) => d.name)).toEqual(["ACC-SINV-2026-00001", "ACC-SINV-2026-00002", "ACC-SINV-2026-00003"]);
    expect(page.docs[0]!.items).toHaveLength(2);
    expect(page.last).toEqual({ modified: "2026-10-17 20:39:08.776123", name: "ACC-SINV-2026-00003" });
  });

  it("continues from the previous page's cursor (recorded second page)", async () => {
    const { adapter, calls } = makeAdapter([jsonResponse(page2())]);

    const page = await adapter.fetchChangedPage({ modified: "2026-10-17 20:39:08.776123", name: "ACC-SINV-2026-00003" }, 2);

    expect(page.docs.map((d) => d.name)).toEqual(["ACC-SINV-2026-00004", "ACC-SINV-2026-00005"]);
    expect(page.last).toEqual({ modified: "2026-10-17 20:39:09.515660", name: "ACC-SINV-2026-00005" });
    expect(JSON.parse(new URL(calls[0]!.url).searchParams.get("or_filters")!)[1]).toEqual(["name", ">", "ACC-SINV-2026-00003"]);
  });

  it("returns last = null for an empty page", async () => {
    const { adapter } = makeAdapter([jsonResponse({ data: [] })]);
    await expect(adapter.fetchChangedPage({ modified: "2030-01-01 00:00:00.000000", name: "" }, 100)).resolves.toEqual({
      docs: [],
      last: null,
    });
  });

  it("normalizes the cursor's modified to fixed width", async () => {
    const doc = { ...page1().data[0]!, modified: "2026-10-17 20:39:07.5" };
    const { adapter } = makeAdapter([jsonResponse({ data: [doc] })]);
    const page = await adapter.fetchChangedPage({ modified: "1900-01-01 00:00:00.000000", name: "" }, 1);
    expect(page.last).toEqual({ modified: "2026-10-17 20:39:07.500000", name: "ACC-SINV-2026-00001" });
  });

  it("throws SourceUnavailableError when the ERP stays unavailable", async () => {
    const { adapter } = makeAdapter([jsonResponse({}, 503), jsonResponse({}, 429, { "Retry-After": "1" })], 2);
    await expect(adapter.fetchChangedPage({ modified: "1900-01-01 00:00:00.000000", name: "" }, 100)).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });
});

describe("normalizeModified", () => {
  it.each([
    ["2026-10-17 20:39:07.886022", "2026-10-17 20:39:07.886022"],
    ["2026-10-17 20:39:07.8", "2026-10-17 20:39:07.800000"],
    ["2026-10-17 20:39:07.0001", "2026-10-17 20:39:07.000100"],
    ["2026-10-17 20:39:07", "2026-10-17 20:39:07.000000"],
    ["2026-10-17T20:39:07.886022", "2026-10-17 20:39:07.886022"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeModified(input)).toBe(expected);
  });

  it("rejects anything else", () => {
    expect(() => normalizeModified("17/10/2026 20:39")).toThrow(/Unrecognized/);
    expect(() => normalizeModified("2026-10-17 20:39:07.1234567")).toThrow(/Unrecognized/);
  });
});

describe("toCandidate", () => {
  it("maps a submitted invoice (recorded)", () => {
    const doc = page1().data[0]!;

    expect(toCandidate(doc, RAW_REF)).toEqual({
      source: "erpnext",
      sourceDocId: "ACC-SINV-2026-00001",
      sourceVersion: "1|2026-10-17 20:39:07.886022",
      rawRef: RAW_REF,
      sourceCustomer: "Blue Ridge Kitchens",
      invoiceDate: "2026-01-14",
      currency: "USD",
      isCreditNote: false,
      status: "final",
      netTotal: 1166,
      lines: [
        {
          lineNo: 1,
          itemCode: "SUGAR-GRAN-25LB",
          description: "Granulated Sugar 25 lb Bag",
          qty: 32,
          unitPrice: 21,
          netAmount: 672,
        },
        {
          lineNo: 2,
          itemCode: "TOMATO-DICED-10",
          description: "Canned Diced Tomatoes #10 Case (6)",
          qty: 13,
          unitPrice: 38,
          netAmount: 494,
        },
      ],
      parseIssues: [],
    });
  });

  it("maps a cancelled invoice (derived from the recording: docstatus 2)", () => {
    const doc = { ...page1().data[0]!, docstatus: 2, modified: "2026-10-18 09:00:00.123456" };
    const candidate = toCandidate(doc, RAW_REF);
    expect(candidate.status).toBe("cancelled");
    expect(candidate.sourceVersion).toBe("2|2026-10-18 09:00:00.123456");
    expect(candidate.netTotal).toBe(1166);
  });

  it("a cancellation's version outranks the submission even with an earlier modified", () => {
    const submitted = toCandidate({ ...page1().data[0]!, modified: "2026-11-01 01:30:00.000000" }, RAW_REF);
    const cancelled = toCandidate({ ...page1().data[0]!, docstatus: 2, modified: "2026-11-01 01:10:00.000000" }, RAW_REF);
    expect(cancelled.sourceVersion > submitted.sourceVersion).toBe(true);
  });

  it("maps a credit note (derived from the recording: is_return 1, negative amounts kept)", () => {
    const base = page1().data[0]!;
    const doc: ErpInvoiceDoc = {
      ...base,
      name: "ACC-SINV-2026-00001-RET",
      is_return: 1,
      return_against: "ACC-SINV-2026-00001",
      base_net_total: -672,
      items: [{ ...base.items![0]!, qty: -32, base_net_amount: -672 }],
    };
    const candidate = toCandidate(doc, RAW_REF);
    expect(candidate.isCreditNote).toBe(true);
    expect(candidate.status).toBe("final");
    expect(candidate.netTotal).toBe(-672);
    expect(candidate.lines).toEqual([
      { lineNo: 1, itemCode: "SUGAR-GRAN-25LB", description: "Granulated Sugar 25 lb Bag", qty: -32, unitPrice: 21, netAmount: -672 },
    ]);
    expect(candidate.parseIssues).toEqual([]);
  });

  it("treats missing and null header fields as null without inventing values", () => {
    const { customer: _c, currency: _cur, posting_date: _p, base_net_total: _t, is_return: _r, ...rest } = page1().data[1]!;
    const doc: ErpInvoiceDoc = { ...rest, currency: null };
    const candidate = toCandidate(doc, RAW_REF);
    expect(candidate.sourceCustomer).toBeNull();
    expect(candidate.currency).toBeNull();
    expect(candidate.invoiceDate).toBeNull();
    expect(candidate.netTotal).toBeNull();
    expect(candidate.isCreditNote).toBe(false);
    expect(candidate.parseIssues).toEqual([]);
  });

  it("handles a document with no items", () => {
    const { items: _i, ...doc } = page1().data[0]!;
    expect(toCandidate(doc, RAW_REF).lines).toEqual([]);
  });

  it("falls back to base_rate when base_net_rate is missing, and nulls missing line text", () => {
    const base = page1().data[0]!;
    const item = { ...base.items![0]!, base_net_rate: null, item_code: null };
    delete (item as Record<string, unknown>).item_name;
    const candidate = toCandidate({ ...base, items: [item] }, RAW_REF);
    expect(candidate.lines[0]).toEqual({ lineNo: 1, itemCode: null, description: null, qty: 32, unitPrice: 21, netAmount: 672 });
    expect(candidate.parseIssues).toEqual([]);
  });

  it("flags MISSING_FIELD (once) when a line amount is missing, instead of publishing a guess", () => {
    const base = page1().data[0]!;
    const items = base.items!.map((item) => ({ ...item, base_net_amount: null }));
    const candidate = toCandidate({ ...base, items }, RAW_REF);
    expect(candidate.lines.map((l) => l.netAmount)).toEqual([0, 0]);
    expect(candidate.parseIssues).toEqual(["MISSING_FIELD"]);
  });

  it("uses the line position when idx is missing", () => {
    const base = page1().data[0]!;
    const items = base.items!.map(({ idx: _idx, ...item }) => item);
    expect(toCandidate({ ...base, items }, RAW_REF).lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it("numbers lines by position even when idx is duplicated, so the line key stays unique", () => {
    const base = page1().data[0]!;
    const items = base.items!.map((item) => ({ ...item, idx: 1 }));
    const lines = toCandidate({ ...base, items }, RAW_REF).lines;
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(lines.map((l) => l.itemCode)).toEqual(base.items!.map((item) => item.item_code)); // stable order
  });

  it("orders lines by idx and numbers them 1..n, whatever the idx values", () => {
    const base = page1().data[0]!;
    const [first, second] = base.items!;
    const items = [
      { ...second!, idx: 7.5 },
      { ...first!, idx: 3 },
    ];
    const lines = toCandidate({ ...base, items }, RAW_REF).lines;
    expect(lines.map((l) => [l.lineNo, l.itemCode])).toEqual([
      [1, first!.item_code],
      [2, second!.item_code],
    ]);
  });

  it.each(["14/01/2026", "2026-1-14", "2026-02-30", "2026-01-14 00:00:00", ""])("flags INVALID_DATE for posting_date %p", (value) => {
    const candidate = toCandidate({ ...page1().data[0]!, posting_date: value }, RAW_REF);
    expect(candidate.invoiceDate).toBeNull();
    expect(candidate.parseIssues).toEqual(["INVALID_DATE"]);
  });

  it("refuses documents without identity (name, modified, docstatus 1|2)", () => {
    const doc = page1().data[0]!;
    expect(() => toCandidate({ ...doc, name: null }, RAW_REF)).toThrow(/without name/);
    expect(() => toCandidate({ ...doc, modified: undefined }, RAW_REF)).toThrow(/without modified/);
    expect(() => toCandidate({ ...doc, docstatus: 0 }, RAW_REF)).toThrow(/unexpected docstatus 0/);
  });

  it("is exposed on the adapter", () => {
    const { adapter } = makeAdapter([]);
    expect(adapter.toCandidate(page1().data[0]!, RAW_REF).sourceDocId).toBe("ACC-SINV-2026-00001");
  });
});
