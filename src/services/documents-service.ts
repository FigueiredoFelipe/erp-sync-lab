// documentsService: the source documents behind one customer-month figure (R12, AC12, US06), from
// public.revenue_document (valid invoices only) and their lines from public.invoice_line.
// Runtime-agnostic: receives a supabase-js client; never reads the environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import { centsToDecimal, toCents } from "../core/money.ts";
import type { Source } from "./customer-revenue-service.ts";
import type { YearMonth } from "./revenue-service.ts";

export interface DocumentFilters {
  customer: string;
  month: YearMonth;
  source: Source | null;
}

export interface DocumentLine {
  lineNo: number;
  itemCode: string | null;
  description: string | null;
  qty: string;
  unitPrice: string;
  netAmount: string;
}

export interface SourceDocument {
  source: string;
  sourceDocId: string;
  invoiceDate: string;
  sourceCustomer: string;
  currency: string;
  amountCents: number;
  amount: string;
  isCreditNote: boolean;
  rawRef: string;
  lines: DocumentLine[];
}

export interface CustomerMonthDocuments {
  customer: { key: string; name: string | null; mapped: boolean };
  month: YearMonth;
  source: Source | null;
  documents: SourceDocument[];
  // Sum of the listed documents: by construction the customer-month figure (AC12).
  total: { revenueCents: number; revenue: string; invoices: number };
}

type DocRow = {
  source: string;
  source_doc_id: string;
  customer_name: string;
  mapped: boolean;
  source_customer: string;
  invoice_date: string;
  currency: string;
  amount: number | string;
  is_credit_note: boolean;
  raw_ref: string;
};

type LineRow = {
  source: string;
  source_doc_id: string;
  line_no: number;
  item_code: string | null;
  description: string | null;
  qty: number | string;
  unit_price: number | string;
  net_amount: number | string;
};

function refuseTruncated(rows: unknown[], count: number | null | undefined, what: string): void {
  if (typeof count === "number" && rows.length < count) throw new Error(`${what}: got ${rows.length} of ${count} rows; refusing a partial list`);
}

export function createDocumentsService(client: SupabaseClient) {
  return {
    async getDocuments(filters: DocumentFilters): Promise<CustomerMonthDocuments> {
      let query = client
        .from("revenue_document")
        .select("source, source_doc_id, customer_name, mapped, source_customer, invoice_date, currency, amount, is_credit_note, raw_ref", { count: "exact" })
        .eq("customer_key", filters.customer)
        .eq("month", `${filters.month}-01`);
      if (filters.source) query = query.eq("source", filters.source);
      const docs = await query.order("invoice_date").order("source").order("source_doc_id");
      if (docs.error) throw new Error(`revenue_document query failed: ${docs.error.message}`);
      const rows = (docs.data ?? []) as DocRow[];
      refuseTruncated(rows, docs.count, "revenue_document");

      const lines = new Map<string, DocumentLine[]>();
      if (rows.length > 0) {
        const result = await client
          .from("invoice_line")
          .select("source, source_doc_id, line_no, item_code, description, qty, unit_price, net_amount", { count: "exact" })
          .in("source_doc_id", [...new Set(rows.map((r) => r.source_doc_id))])
          .order("line_no");
        if (result.error) throw new Error(`invoice_line query failed: ${result.error.message}`);
        const lineRows = (result.data ?? []) as LineRow[];
        refuseTruncated(lineRows, result.count, "invoice_line");
        for (const line of lineRows) {
          // The key is (source, source_doc_id): the same id in the other source is another document.
          const key = `${line.source}\u0000${line.source_doc_id}`;
          const list = lines.get(key) ?? [];
          list.push({
            lineNo: line.line_no,
            itemCode: line.item_code,
            description: line.description,
            qty: String(line.qty),
            unitPrice: centsToDecimal(toCents(line.unit_price)),
            netAmount: centsToDecimal(toCents(line.net_amount)),
          });
          lines.set(key, list);
        }
      }

      const documents = rows.map((row) => {
        const cents = toCents(row.amount);
        return {
          source: row.source,
          sourceDocId: row.source_doc_id,
          invoiceDate: row.invoice_date,
          sourceCustomer: row.source_customer,
          currency: row.currency,
          amountCents: cents,
          amount: centsToDecimal(cents),
          isCreditNote: row.is_credit_note,
          rawRef: row.raw_ref,
          lines: lines.get(`${row.source}\u0000${row.source_doc_id}`) ?? [],
        };
      });
      const totalCents = documents.reduce((sum, d) => sum + d.amountCents, 0);

      return {
        customer: { key: filters.customer, name: rows[0]?.customer_name ?? null, mapped: rows[0]?.mapped ?? !filters.customer.startsWith("unmapped:") },
        month: filters.month,
        source: filters.source,
        documents,
        total: { revenueCents: totalCents, revenue: centsToDecimal(totalCents), invoices: documents.length },
      };
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
