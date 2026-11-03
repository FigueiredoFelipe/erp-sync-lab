// The public demo's data: an allowlist of figures copied once from the live pipeline (scripts/demo/export-snapshot.ts)
// into app/demo/snapshot.json. The /demo page reads only that file, so the public site never touches a database.
// Only the fields below are copied: no error text, no internal ids, no raw customer strings from the sources.
import type { Freshness } from "../services/freshness-service.ts";
import type { MonthlyRevenue } from "../services/revenue-service.ts";
import type { CustomerRevenue } from "../services/customer-revenue-service.ts";
import type { QuarantineList } from "../services/quarantine-service.ts";

export interface SnapshotSources {
  generatedAt: string;
  monthly: MonthlyRevenue;
  customers: { customers: Pick<CustomerRevenue["customers"][number], "key" | "name" | "mapped" | "total">[] };
  quarantine: Pick<QuarantineList, "count" | "byReason" | "entries">;
  freshness: {
    erpnext: Freshness["erpnext"];
    legacyUnitB: Freshness["legacyUnitB"];
    consumer: Freshness["consumer"];
    queue: Freshness["queue"];
    deadLetter: Freshness["deadLetter"];
    reconciliation: { lastSucceeded: Freshness["reconciliation"]["lastSucceeded"] };
  };
}

export interface DemoMonth {
  month: string;
  erpnextCents: number;
  legacyCents: number;
  totalCents: number;
  invoices: number;
  complete: boolean;
}

export interface DemoSnapshot {
  generatedAt: string;
  asOfDate: string;
  months: DemoMonth[];
  total: { erpnextCents: number; legacyCents: number; totalCents: number; invoices: number };
  topCustomers: { name: string; totalCents: number; invoices: number; mapped: boolean }[];
  quarantine: {
    count: number;
    byReason: { reasonCode: string; count: number }[];
    examples: { source: string; sourceDocId: string; reasonCode: string }[];
  };
  health: {
    erpnextLastSuccessfulSync: string | null;
    legacyNewestExport: string | null;
    legacyLastIngest: string | null;
    consumerProcessed: number;
    consumerParked: number;
    queuePending: number | null;
    deadLetter: number;
    reconciliation: { finishedAt: string | null; erpTotal: string | null; storedTotal: string | null; unexplained: number | null } | null;
  };
}

// Anything that looks like an e-mail, URL, IP address, hosting provider, token or deployment id.
export const LEAK_PATTERN = /@|https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b|supabase\.(co|com|in)|frappe|eyJ|prj_|figueiredofelipes/i;

const TOP_CUSTOMERS = 8;
const QUARANTINE_EXAMPLES = 6;

export function toDemoSnapshot(input: SnapshotSources): DemoSnapshot {
  const { monthly, customers, quarantine, freshness } = input;
  const last = freshness.reconciliation.lastSucceeded;
  return {
    generatedAt: input.generatedAt,
    asOfDate: monthly.asOf.date,
    months: monthly.months.map((m) => ({
      month: m.month,
      erpnextCents: m.bySource.erpnext.revenueCents,
      legacyCents: m.bySource.legacy_unit_b.revenueCents,
      totalCents: m.revenueCents,
      invoices: m.invoices,
      complete: m.complete,
    })),
    total: {
      erpnextCents: monthly.total.bySource.erpnext.revenueCents,
      legacyCents: monthly.total.bySource.legacy_unit_b.revenueCents,
      totalCents: monthly.total.revenueCents,
      invoices: monthly.total.invoices,
    },
    topCustomers: [...customers.customers]
      .sort((a, b) => b.total.revenueCents - a.total.revenueCents)
      .slice(0, TOP_CUSTOMERS)
      .map((c) => ({ name: c.name, totalCents: c.total.revenueCents, invoices: c.total.invoices, mapped: c.mapped })),
    quarantine: {
      count: quarantine.count,
      byReason: quarantine.byReason.map((r) => ({ reasonCode: r.reasonCode, count: r.count })),
      examples: quarantine.entries
        .slice(0, QUARANTINE_EXAMPLES)
        .map((e) => ({ source: e.source, sourceDocId: e.sourceDocId, reasonCode: e.reasonCode })),
    },
    health: {
      erpnextLastSuccessfulSync: freshness.erpnext.lastSuccessfulSync,
      legacyNewestExport: freshness.legacyUnitB.newestExportDate,
      legacyLastIngest: freshness.legacyUnitB.lastSuccessfulIngest,
      consumerProcessed: freshness.consumer.processed,
      consumerParked: freshness.consumer.parked,
      queuePending: freshness.queue.pending,
      deadLetter: freshness.deadLetter.count,
      reconciliation: last
        ? { finishedAt: last.finishedAt, erpTotal: last.erpTotal, storedTotal: last.storedTotal, unexplained: last.unexplained }
        : null,
    },
  };
}
