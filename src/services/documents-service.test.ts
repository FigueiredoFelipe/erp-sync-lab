import { describe, expect, it } from "@jest/globals";
import { fakeSupabase, issuedNames } from "../../tests/http/fake-supabase.ts";
import { createDocumentsService } from "./documents-service.ts";

const DOC = {
  source: "erpnext",
  source_doc_id: "ACC-SINV-2026-00012",
  customer_name: "Acme Foods Inc.",
  mapped: true,
  source_customer: "Acme Foods Inc.",
  invoice_date: "2026-03-04",
  currency: "USD",
  amount: 280,
  is_credit_note: false,
  raw_ref: "erpnext/ACC-SINV-2026-00012/1-x.json",
};
const LINE = { source: "erpnext", source_doc_id: "ACC-SINV-2026-00012", line_no: 1, item_code: "FLOUR-AP-50LB", description: "Flour", qty: 10, unit_price: 28, net_amount: 280 };
const FILTERS = { customer: "acme", month: "2026-03", source: null };

describe("documentsService.getDocuments", () => {
  it("takes exactly two round trips: the documents, then their lines", async () => {
    const fake = fakeSupabase({ revenue_document: { data: [DOC], error: null }, invoice_line: { data: [LINE], error: null } }, {}, { deferred: true });
    const promise = createDocumentsService(fake.client).getDocuments(FILTERS);
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["revenue_document"]);
    fake.releaseAll();
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["invoice_line", "revenue_document"]);
    fake.releaseAll();
    const result = await promise;
    expect(result.documents.map((d) => [d.sourceDocId, d.lines.length])).toEqual([["ACC-SINV-2026-00012", 1]]);
    expect(fake.calls.find((c) => c.table === "invoice_line")?.chain).toContainEqual(["in", "source_doc_id", ["ACC-SINV-2026-00012"]]);
  });

  it("takes one round trip when no document matches", async () => {
    const fake = fakeSupabase({ revenue_document: { data: [], error: null } }, {}, { deferred: true });
    const promise = createDocumentsService(fake.client).getDocuments(FILTERS);
    await fake.settle();
    fake.releaseAll();
    expect((await promise).documents).toEqual([]);
    expect(issuedNames(fake)).toEqual(["revenue_document"]);
  });
});
