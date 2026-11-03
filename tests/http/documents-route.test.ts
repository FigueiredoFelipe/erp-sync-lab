import { describe, expect, it, jest } from "@jest/globals";
import * as route from "../../app/api/revenue/documents/route.ts";
import { createDocumentsHandler } from "../../src/http/documents-handler.ts";
import { aggregateByCustomer, type ViewRow } from "../../src/services/customer-revenue-service.ts";
import { createDocumentsService, type CustomerMonthDocuments } from "../../src/services/documents-service.ts";
import { fakeSupabase, issuedNames, type Result } from "./fake-supabase.ts";

// T23: GET /api/revenue/documents — handler + documentsService over a fake database client.
const URL_BASE = "http://localhost:3000/api/revenue/documents";

const DOCS = [
  { source: "erpnext", source_doc_id: "ACC-SINV-2026-00012", customer_name: "Acme Foods Inc.", mapped: true, source_customer: "Acme Foods Inc.", invoice_date: "2026-03-04", currency: "USD", amount: 1000.1, is_credit_note: false, raw_ref: "erpnext/ACC-SINV-2026-00012/1-x.json" },
  { source: "legacy_unit_b", source_doc_id: "UB-26030", customer_name: "Acme Foods Inc.", mapped: true, source_customer: "ACME FOODS", invoice_date: "2026-03-09", currency: "USD", amount: "200.05", is_credit_note: false, raw_ref: "legacy/unit_b_export_2026-10-16.csv#UB-26030" },
  { source: "erpnext", source_doc_id: "ACC-SINV-2026-00099", customer_name: "Acme Foods Inc.", mapped: true, source_customer: "Acme Foods Inc.", invoice_date: "2026-03-28", currency: "USD", amount: -150, is_credit_note: true, raw_ref: "erpnext/ACC-SINV-2026-00099/1-x.json" },
];
const LINES = [
  { source: "erpnext", source_doc_id: "ACC-SINV-2026-00012", line_no: 1, item_code: "FLOUR-AP-50LB", description: "Flour", qty: 10, unit_price: 28, net_amount: 280 },
  { source: "erpnext", source_doc_id: "ACC-SINV-2026-00012", line_no: 2, item_code: "OIL-EVOO-3L", description: "Oil", qty: 17, unit_price: "42.36", net_amount: "720.10" },
  { source: "legacy_unit_b", source_doc_id: "UB-26030", line_no: 1, item_code: null, description: "RICE LG 25LB", qty: "8.5", unit_price: "23.53", net_amount: "200.05" },
];

function handlerWith(docs: Result, lines: Result = { data: LINES, error: null }, deferred = false) {
  const fake = fakeSupabase({ revenue_document: docs, invoice_line: lines }, {}, { deferred });
  return { GET: createDocumentsHandler(() => createDocumentsService(fake.client)), calls: fake.calls, fake };
}

describe("GET /api/revenue/documents", () => {
  it("lists the documents and lines of a customer-month", async () => {
    const { GET, calls } = handlerWith({ data: DOCS, error: null, count: 3 });
    const response = await GET(new Request(`${URL_BASE}?customer=acme&month=2026-03`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as CustomerMonthDocuments;
    expect(body.customer).toEqual({ key: "acme", name: "Acme Foods Inc.", mapped: true });
    expect(body.documents.map((d) => [d.source, d.sourceDocId, d.amount, d.lines.length])).toEqual([
      ["erpnext", "ACC-SINV-2026-00012", "1000.10", 2],
      ["legacy_unit_b", "UB-26030", "200.05", 1],
      ["erpnext", "ACC-SINV-2026-00099", "-150.00", 0],
    ]);
    expect(body.documents[0]?.lines[1]).toEqual({ lineNo: 2, itemCode: "OIL-EVOO-3L", description: "Oil", qty: "17", unitPrice: "42.36", netAmount: "720.10" });
    expect(body.total).toEqual({ revenueCents: 105015, revenue: "1050.15", invoices: 3 });
    expect(calls[0]?.chain).toEqual(expect.arrayContaining([["eq", "customer_key", "acme"], ["eq", "month", "2026-03-01"]]));
  });

  it("AC12: the listed documents add up to the customer-month figure", async () => {
    // The figure, as the Customers page computes it from the view row of the same invoices.
    const view: ViewRow[] = [
      { month: "2026-03-01", source: "erpnext", customer_key: "acme", customer_name: "Acme Foods Inc.", mapped: true, revenue: "850.10", invoices: 2 },
      { month: "2026-03-01", source: "legacy_unit_b", customer_key: "acme", customer_name: "Acme Foods Inc.", mapped: true, revenue: "200.05", invoices: 1 },
    ];
    const figure = aggregateByCustomer(view, ["2026-03"])[0]?.months[0];
    const { GET } = handlerWith({ data: DOCS, error: null });
    const body = (await (await GET(new Request(`${URL_BASE}?customer=acme&month=2026-03`))).json()) as CustomerMonthDocuments;
    expect(body.documents.reduce((sum, d) => sum + d.amountCents, 0)).toBe(figure?.revenueCents);
    expect(body.total.invoices).toBe(figure?.invoices);
  });

  it("passes the source filter, so the drill-down matches a source-filtered figure", async () => {
    const { GET, calls } = handlerWith({ data: [], error: null });
    const response = await GET(new Request(`${URL_BASE}?customer=${encodeURIComponent("unmapped:legacy_unit_b:Old Mill Tavern")}&month=2026-02&source=legacy_unit_b`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as CustomerMonthDocuments;
    expect(body.customer).toEqual({ key: "unmapped:legacy_unit_b:Old Mill Tavern", name: null, mapped: false });
    expect(body.total).toEqual({ revenueCents: 0, revenue: "0.00", invoices: 0 });
    expect(calls[0]?.chain).toContainEqual(["eq", "source", "legacy_unit_b"]);
    // No documents: invoice_line is not queried.
    expect(calls.some((c) => c.table === "invoice_line")).toBe(false);
  });

  it("answers in exactly two round trips: the documents, then their lines", async () => {
    const { GET, fake } = handlerWith({ data: DOCS, error: null, count: 3 }, undefined, true);
    const pending = GET(new Request(`${URL_BASE}?customer=acme&month=2026-03`));
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["revenue_document"]);
    fake.releaseAll();
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["invoice_line", "revenue_document"]);
    fake.releaseAll();
    expect((await pending).status).toBe(200);
  });

  it.each([
    ["month=2026-03", "'customer' is required"],
    ["customer=acme", "'month' is required"],
    ["customer=acme&month=2026-3", "'month' must be YYYY-MM"],
    ["customer=acme&month=2026-03&source=sap", "'source' must be one of"],
    ["customer=acme&month=2026-03&page=2", "Unknown query parameter 'page'"],
  ])("rejects %s with 400 Problem Details", async (query, detail) => {
    const { GET, calls } = handlerWith({ data: [], error: null });
    const response = await GET(new Request(`${URL_BASE}?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
    expect(body["detail"]).toContain(detail);
    expect(calls).toHaveLength(0);
  });

  it("returns 500 Problem Details when the documents or the lines fail, or are truncated", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const cases: [Result, Result?][] = [
      [{ data: null, error: { message: "connection refused to secret-host" } }],
      [{ data: DOCS, error: null }, { data: null, error: { message: "lines down" } }],
      [{ data: DOCS, error: null, count: 4 }],
      [{ data: DOCS, error: null }, { data: LINES, error: null, count: 9 }],
    ];
    for (const [docs, lines] of cases) {
      const { GET } = handlerWith(docs, lines);
      const response = await GET(new Request(`${URL_BASE}?customer=acme&month=2026-03`));
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 500, detail: "Unexpected error while reading the source documents." });
      expect(JSON.stringify(body)).not.toContain("secret-host");
    }
    spy.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405 and Allow: GET", async (method) => {
    const response = await route[method](new Request(URL_BASE, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});
