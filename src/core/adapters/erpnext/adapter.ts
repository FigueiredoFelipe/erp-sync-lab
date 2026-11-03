// ERPNext adapter (PLAN "Canonical model and adapters", "Source A: incremental fetch"). GET only (BR09).
// Fetches Sales Invoices in (modified, name) keyset order and translates them into canonical candidates.
// It translates, it doesn't judge: validation decides what a null or a parse issue means.

import type { CandidateLine, CanonicalCandidate, ReasonCode } from "../../canonical.ts";
import type { ChangedPage, ChangeSource, Cursor } from "../../sync/contracts.ts";
import type { ErpNextHttpClient } from "./http-client.ts";

export type ErpInvoiceItem = {
  name?: string | null;
  idx?: number | null;
  item_code?: string | null;
  item_name?: string | null;
  qty?: number | null;
  base_rate?: number | null;
  base_net_rate?: number | null;
  base_net_amount?: number | null;
};

// A Sales Invoice as returned by the list query below. Every field is optional because a single-doc GET
// omits nulls and a source can always send less than promised.
export type ErpInvoiceDoc = {
  name?: string | null;
  docstatus?: number | null;
  modified?: string | null;
  company?: string | null;
  customer?: string | null;
  posting_date?: string | null;
  currency?: string | null;
  is_return?: number | null;
  return_against?: string | null;
  amended_from?: string | null;
  base_net_total?: number | null;
  items?: ErpInvoiceItem[] | null;
};

export const INVOICE_DOCTYPE_PATH = "/api/resource/Sales%20Invoice";

export const INVOICE_FIELDS = [
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
] as const;

export const ITEM_FIELDS = ["name", "idx", "item_code", "item_name", "qty", "base_rate", "base_net_rate", "base_net_amount"] as const;

// A row of Frappe's Deleted Document log (fields confirmed with a GET on 2026-10-18: deleted_doctype,
// deleted_name, creation, data). `data` is the deleted document as JSON text, as it was when deleted.
export type ErpDeletedDoc = {
  name?: string | null;
  deleted_doctype?: string | null;
  deleted_name?: string | null;
  creation?: string | null;
  data?: string | null;
};

export const DELETED_DOCTYPE_PATH = "/api/resource/Deleted%20Document";

export const DELETED_FIELDS = ["name", "deleted_doctype", "deleted_name", "creation", "data"] as const;

// What reconciliation needs of a submitted invoice (R14).
export type ErpSubmittedDoc = {
  name: string;
  modified: string; // fixed-width "YYYY-MM-DD HH:MM:SS.ffffff"
  postingDate: string;
  baseNetTotal: number;
};

export const SUBMITTED_PAGE_SIZE = 500;

export type ErpNextAdapterConfig = {
  client: ErpNextHttpClient;
  company: string;
};

export class ErpNextAdapter implements ChangeSource<ErpInvoiceDoc> {
  readonly #client: ErpNextHttpClient;
  readonly #company: string;

  constructor(config: ErpNextAdapterConfig) {
    this.#client = config.client;
    this.#company = config.company;
  }

  // Invoices strictly after `after` in (modified, name) order: Frappe combines `filters AND (or_filters)`,
  // which gives `modified > M OR (modified = M AND name > N)`. Lines come nested, so `limit` counts invoices.
  async fetchChangedPage(after: Cursor, limit: number): Promise<ChangedPage<ErpInvoiceDoc>> {
    const res = await this.#client.get<{ data: ErpInvoiceDoc[] }>(INVOICE_DOCTYPE_PATH, {
      fields: [...INVOICE_FIELDS, { items: [...ITEM_FIELDS] }],
      filters: [
        ["company", "=", this.#company],
        ["docstatus", "in", [1, 2]],
        ["modified", ">=", after.modified],
      ],
      or_filters: [
        ["modified", ">", after.modified],
        ["name", ">", after.name],
      ],
      order_by: "modified asc, name asc",
      limit,
    });
    const docs = res.data;
    const lastDoc = docs.at(-1);
    return { docs, last: lastDoc ? cursorOf(lastDoc) : null };
  }

  // Deleted Sales Invoices strictly after `after` in (creation, name) order, the same keyset as invoices
  // (EC12). Deleted Document has no company field; the company is checked by the caller from `data`.
  async fetchDeletedPage(after: Cursor, limit: number): Promise<ChangedPage<ErpDeletedDoc>> {
    const res = await this.#client.get<{ data: ErpDeletedDoc[] }>(DELETED_DOCTYPE_PATH, {
      fields: [...DELETED_FIELDS],
      filters: [
        ["deleted_doctype", "=", "Sales Invoice"],
        ["creation", ">=", after.modified],
      ],
      or_filters: [
        ["creation", ">", after.modified],
        ["name", ">", after.name],
      ],
      order_by: "creation asc, name asc",
      limit,
    });
    const docs = res.data;
    const lastDoc = docs.at(-1);
    return { docs, last: lastDoc ? deletedCursorOf(lastDoc) : null };
  }

  // The deleted stream as a ChangeSource, so IncrementalSync can drive it with its own cursor.
  deletedInvoices(): ChangeSource<ErpDeletedDoc> {
    return { fetchChangedPage: (after, limit) => this.fetchDeletedPage(after, limit) };
  }

  // Every submitted (docstatus 1) invoice of `company` with posting_date in [from, to], paged by name
  // (keyset, so a document submitted while paging can't shift a page and hide another one).
  async fetchSubmittedDocuments(company: string, from: string, to: string, pageSize = SUBMITTED_PAGE_SIZE): Promise<ErpSubmittedDoc[]> {
    const out: ErpSubmittedDoc[] = [];
    let after = "";
    for (;;) {
      const res = await this.#client.get<{ data: ErpInvoiceDoc[] }>(INVOICE_DOCTYPE_PATH, {
        fields: ["name", "modified", "posting_date", "base_net_total"],
        filters: [
          ["company", "=", company],
          ["docstatus", "=", 1],
          ["posting_date", ">=", from],
          ["posting_date", "<=", to],
          ["name", ">", after],
        ],
        order_by: "name asc",
        limit: pageSize,
      });
      for (const doc of res.data) {
        const baseNetTotal = numberOrNull(doc.base_net_total);
        const postingDate = parseIsoDate(doc.posting_date);
        if (baseNetTotal === null || postingDate === null || postingDate === "invalid") {
          throw new Error(`ERPNext invoice ${doc.name ?? "?"} without a usable base_net_total or posting_date`);
        }
        out.push({ name: requireString(doc.name, "name"), modified: normalizeModified(requireString(doc.modified, "modified")), postingDate, baseNetTotal });
      }
      if (res.data.length < pageSize) return out;
      after = out[out.length - 1]!.name;
    }
  }

  // The current version of one Sales Invoice (webhook hints, T21), reduced to the fields the poll fetches,
  // so a hint and a poll produce the same record. Throws ErpNextRequestError (404) when it doesn't exist.
  async fetchDocument(name: string): Promise<ErpInvoiceDoc> {
    const res = await this.#client.get<{ data: Record<string, unknown> }>(`${INVOICE_DOCTYPE_PATH}/${encodeURIComponent(name)}`);
    return pickInvoiceFields(res.data);
  }

  toCandidate(doc: ErpInvoiceDoc, rawRef: string): CanonicalCandidate {
    return toCandidate(doc, rawRef);
  }
}

// Keeps the list query's fields (INVOICE_FIELDS plus items with ITEM_FIELDS); a field the single-doc GET
// omitted (Frappe drops nulls) stays absent, as in a list row that lacks it.
export function pickInvoiceFields(full: Record<string, unknown>): ErpInvoiceDoc {
  const pick = (source: Record<string, unknown>, fields: readonly string[]) =>
    Object.fromEntries(fields.filter((f) => f in source).map((f) => [f, source[f]]));
  const doc = pick(full, INVOICE_FIELDS) as ErpInvoiceDoc;
  if (Array.isArray(full["items"])) {
    doc.items = (full["items"] as Record<string, unknown>[]).map((item) => pick(item, ITEM_FIELDS));
  }
  return doc;
}

// Position of a Deleted Document row: (creation, name), creation in the fixed-width format.
export function deletedCursorOf(doc: ErpDeletedDoc): Cursor {
  return { modified: normalizeModified(requireString(doc.creation, "creation")), name: requireString(doc.name, "name") };
}

export function cursorOf(doc: ErpInvoiceDoc): Cursor {
  return { modified: normalizeModified(requireString(doc.modified, "modified")), name: requireString(doc.name, "name") };
}

// "<docstatus>|<fixed-width modified>": a cancellation (2) always outranks a submission (1).
export function sourceVersionOf(doc: ErpInvoiceDoc): string {
  return `${requireDocstatus(doc)}|${normalizeModified(requireString(doc.modified, "modified"))}`;
}

// ERPNext `modified` is naive America/New_York with up to 6 fractional digits. Fixed width keeps it
// comparable as text: "YYYY-MM-DD HH:MM:SS.ffffff".
export function normalizeModified(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`Unrecognized ERPNext modified timestamp: ${JSON.stringify(value)}`);
  return `${match[1]} ${match[2]}.${(match[3] ?? "").padEnd(6, "0")}`;
}

export function toCandidate(doc: ErpInvoiceDoc, rawRef: string): CanonicalCandidate {
  const parseIssues: ReasonCode[] = [];
  const name = requireString(doc.name, "name");
  const docstatus = requireDocstatus(doc);

  const invoiceDate = parseIsoDate(doc.posting_date);
  if (invoiceDate === "invalid") parseIssues.push("INVALID_DATE");

  // Line numbers are positions (1..n) in idx order, never idx itself: a duplicate or non-integer idx
  // would otherwise break the invoice_line primary key and poison the message.
  const lines: CandidateLine[] = inIdxOrder(doc.items ?? []).map((item, index) => {
    const unitPrice = numberOrNull(item.base_net_rate) ?? numberOrNull(item.base_rate);
    const qty = numberOrNull(item.qty);
    const netAmount = numberOrNull(item.base_net_amount);
    // CandidateLine numbers can't be null; a missing amount becomes 0 and is flagged, so validation
    // quarantines the invoice instead of publishing it (fail-closed).
    if (unitPrice === null || qty === null || netAmount === null) addOnce(parseIssues, "MISSING_FIELD");
    return {
      lineNo: index + 1,
      itemCode: stringOrNull(item.item_code),
      description: stringOrNull(item.item_name),
      qty: qty ?? 0,
      unitPrice: unitPrice ?? 0,
      netAmount: netAmount ?? 0,
    };
  });

  return {
    source: "erpnext",
    sourceDocId: name,
    sourceVersion: sourceVersionOf(doc),
    rawRef,
    sourceCustomer: stringOrNull(doc.customer),
    invoiceDate: invoiceDate === "invalid" ? null : invoiceDate,
    currency: stringOrNull(doc.currency),
    isCreditNote: doc.is_return === 1,
    status: docstatus === 2 ? "cancelled" : "final",
    netTotal: numberOrNull(doc.base_net_total),
    lines,
    parseIssues,
  };
}

// Stable sort by idx; items without a numeric idx keep their relative order after the others.
function inIdxOrder(items: ErpInvoiceItem[]): ErpInvoiceItem[] {
  const key = (item: ErpInvoiceItem) => numberOrNull(item.idx) ?? Number.POSITIVE_INFINITY;
  return items
    .map((item, position) => ({ item, position }))
    .sort((a, b) => {
      const ka = key(a.item);
      const kb = key(b.item);
      return ka === kb ? a.position - b.position : ka < kb ? -1 : 1;
    })
    .map(({ item }) => item);
}

// Strict YYYY-MM-DD that is also a real calendar date. Missing → null (validation reports MISSING_FIELD).
function parseIsoDate(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "invalid";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "invalid";
}

// Identity fields are invariants of the query (name, modified, docstatus 1|2); without them there is no
// key or version to store, so the adapter refuses the document instead of inventing one.
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`ERPNext invoice without ${field}`);
  return value;
}

function requireDocstatus(doc: ErpInvoiceDoc): 1 | 2 {
  if (doc.docstatus === 1 || doc.docstatus === 2) return doc.docstatus;
  throw new Error(`ERPNext invoice ${doc.name ?? "?"} has unexpected docstatus ${String(doc.docstatus)}`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addOnce(issues: ReasonCode[], code: ReasonCode): void {
  if (!issues.includes(code)) issues.push(code);
}
