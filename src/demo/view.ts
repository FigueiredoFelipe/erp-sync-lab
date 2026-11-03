// What the /demo page shows, built from the frozen snapshot: labels and formatted money only, no logic in the page.
import { formatUsdCents, toCents } from "../core/money.ts";
import type { DemoSnapshot } from "./snapshot.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const REASONS: Record<string, string> = {
  TOTAL_MISMATCH: "Total mismatch",
  CONFLICTING_DUPLICATE: "Conflicting duplicate",
  INVALID_DATE: "Invalid date",
  MISSING_FIELD: "Missing field",
  UNSUPPORTED_CURRENCY: "Unsupported currency",
  UNKNOWN_CUSTOMER: "Unknown customer",
};

function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

function dateLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
}

function reasonLabel(code: string): string {
  return REASONS[code] ?? code.toLowerCase().replaceAll("_", " ");
}

export function buildDemoView(s: DemoSnapshot) {
  const r = s.health.reconciliation;
  return {
    frozenOn: dateLabel(s.generatedAt),
    asOf: dateLabel(s.asOfDate),
    months: s.months.map((m) => ({
      label: monthLabel(m.month),
      erpnext: formatUsdCents(m.erpnextCents),
      legacy: formatUsdCents(m.legacyCents),
      total: formatUsdCents(m.totalCents),
      invoices: m.invoices,
      partial: !m.complete,
    })),
    total: {
      erpnext: formatUsdCents(s.total.erpnextCents),
      legacy: formatUsdCents(s.total.legacyCents),
      total: formatUsdCents(s.total.totalCents),
      invoices: s.total.invoices,
    },
    customers: s.topCustomers.map((c) => ({ name: c.name, total: formatUsdCents(c.totalCents), invoices: c.invoices })),
    quarantineCount: s.quarantine.count,
    quarantine: s.quarantine.byReason.map((q) => ({ reason: reasonLabel(q.reasonCode), code: q.reasonCode, count: q.count })),
    quarantineExamples: s.quarantine.examples.map((e) => ({
      source: e.source === "erpnext" ? "ERPNext" : "Legacy export",
      document: e.sourceDocId,
      reason: reasonLabel(e.reasonCode),
    })),
    health: [
      { label: "ERPNext last successful sync", value: s.health.erpnextLastSuccessfulSync ? dateLabel(s.health.erpnextLastSuccessfulSync) : "never" },
      { label: "Legacy export, newest file", value: s.health.legacyNewestExport ? dateLabel(s.health.legacyNewestExport) : "none" },
      { label: "Queue: pending messages", value: String(s.health.queuePending ?? "unknown") },
      { label: "Dead-letter queue", value: String(s.health.deadLetter) },
    ],
    reconciliation: r?.erpTotal != null && r.storedTotal != null
      ? `ERPNext ${formatUsdCents(toCents(r.erpTotal))} ${toCents(r.erpTotal) === toCents(r.storedTotal) ? "=" : "≠"} stored ${formatUsdCents(toCents(r.storedTotal))}, ${r.unexplained ?? 0} unexplained`
      : "No successful run in this snapshot",
  };
}

export type DemoView = ReturnType<typeof buildDemoView>;
