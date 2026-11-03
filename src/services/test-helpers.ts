// Test-only builders for queue messages in the exact shape T6 produces. Never imported by runtime code.
import type { ErpInvoiceDoc } from "../core/adapters/erpnext/adapter.ts";
import { normalizeModified } from "../core/adapters/erpnext/adapter.ts";
import { loadFixture } from "../core/adapters/erpnext/test-helpers.ts";

export function fixtureDocs(): ErpInvoiceDoc[] {
  const page1 = loadFixture<{ data: ErpInvoiceDoc[] }>("changed-page-1.json");
  const page2 = loadFixture<{ data: ErpInvoiceDoc[] }>("changed-page-2.json");
  return [...page1.data, ...page2.data].map((doc) => structuredClone(doc));
}

export function recordMessage(doc: ErpInvoiceDoc): Record<string, unknown> {
  const modified = normalizeModified(String(doc.modified));
  return {
    v: 1,
    kind: "record",
    source: "erpnext",
    sourceDocId: doc.name,
    sourceVersion: `${String(doc.docstatus)}|${modified}`,
    rawRef: `erpnext/${String(doc.name)}/${String(doc.docstatus)}-${modified}.json`,
    doc,
  };
}
