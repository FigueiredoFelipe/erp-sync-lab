// quarantineService: the open quarantine (R09, US04) — every rejected record, why, and since when.
// Runtime-agnostic: receives a supabase-js client; never reads the environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Source } from "./customer-revenue-service.ts";

// The one reason code per record (SPEC "Validation", schema check constraint).
export const REASON_CODES = [
  "MISSING_FIELD",
  "INVALID_DATE",
  "UNSUPPORTED_CURRENCY",
  "CONFLICTING_DUPLICATE",
  "TOTAL_MISMATCH",
  "UNKNOWN_CUSTOMER",
  "PROCESSING_FAILED",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface QuarantineFilters {
  source: Source | null;
  reason: ReasonCode | null;
}

export interface QuarantineEntry {
  source: string;
  sourceDocId: string;
  reasonCode: string;
  detail: string | null;
  sourceCustomer: string | null;
  firstRejectedAt: string;
  lastRejectedAt: string;
}

export interface QuarantineList {
  source: Source | null;
  reason: ReasonCode | null;
  count: number;
  // Open entries per reason code, over the filtered list.
  byReason: { reasonCode: string; count: number }[];
  entries: QuarantineEntry[];
}

type Row = {
  source: string;
  source_doc_id: string;
  reason_code: string;
  detail: string | null;
  source_customer: string | null;
  first_rejected_at: string;
  last_rejected_at: string;
};

export function createQuarantineService(client: SupabaseClient) {
  return {
    async listOpen(filters: QuarantineFilters): Promise<QuarantineList> {
      let query = client
        .from("quarantine")
        .select("source, source_doc_id, reason_code, detail, source_customer, first_rejected_at, last_rejected_at", { count: "exact" })
        .eq("status", "open");
      if (filters.source) query = query.eq("source", filters.source);
      if (filters.reason) query = query.eq("reason_code", filters.reason);
      const { data, error, count } = await query
        .order("last_rejected_at", { ascending: false })
        .order("source", { ascending: true })
        .order("source_doc_id", { ascending: true });
      if (error) throw new Error(`quarantine query failed: ${error.message}`);
      const rows = (data ?? []) as Row[];
      // A truncated list would hide records that are missing from the totals.
      if (typeof count === "number" && rows.length < count) {
        throw new Error(`quarantine: got ${rows.length} of ${count} rows; refusing a partial list`);
      }

      const byReason = new Map<string, number>();
      for (const row of rows) byReason.set(row.reason_code, (byReason.get(row.reason_code) ?? 0) + 1);

      return {
        source: filters.source,
        reason: filters.reason,
        count: rows.length,
        byReason: [...byReason].map(([reasonCode, n]) => ({ reasonCode, count: n })).sort((a, b) => b.count - a.count || a.reasonCode.localeCompare(b.reasonCode)),
        entries: rows.map((row) => ({
          source: row.source,
          sourceDocId: row.source_doc_id,
          reasonCode: row.reason_code,
          detail: row.detail,
          sourceCustomer: row.source_customer,
          firstRejectedAt: row.first_rejected_at,
          lastRejectedAt: row.last_rejected_at,
        })),
      };
    },
  };
}

export type QuarantineService = ReturnType<typeof createQuarantineService>;
