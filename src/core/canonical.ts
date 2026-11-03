// Canonical candidate: the common shape every source adapter produces before validation (PLAN "Canonical model and adapters").
// Fields can be null because the record may still be invalid; validation decides.

// The canonical source list, in a fixed order (R19: ERPNext is the segment nearest zero on the revenue chart).
export const SOURCE_IDS = ["erpnext", "legacy_unit_b"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type ReasonCode =
  | "MISSING_FIELD"
  | "INVALID_DATE"
  | "UNSUPPORTED_CURRENCY"
  | "CONFLICTING_DUPLICATE"
  | "TOTAL_MISMATCH"
  | "UNKNOWN_CUSTOMER"
  | "PROCESSING_FAILED";

export type CandidateLine = {
  lineNo: number;
  itemCode: string | null;
  description: string | null;
  qty: number;
  unitPrice: number;
  netAmount: number;
};

export type CanonicalCandidate = {
  source: SourceId;
  sourceDocId: string; // ERPNext name, or Source B INV_NO (or "<object>#row<n>")
  sourceVersion: string; // ERPNext "<docstatus>|<modified>"; Source B export date "YYYY-MM-DD"
  rawRef: string; // Storage path of the raw payload
  sourceCustomer: string | null; // ERPNext customer ID, or Source B CUST_NAME as written
  invoiceDate: string | null; // ISO date after strict source-specific parsing
  currency: string | null;
  isCreditNote: boolean;
  status: "final" | "cancelled";
  netTotal: number | null;
  lines: CandidateLine[];
  parseIssues: ReasonCode[]; // e.g. INVALID_DATE found while parsing
};
