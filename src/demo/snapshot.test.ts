import { describe, expect, it } from "@jest/globals";
import { LEAK_PATTERN, toDemoSnapshot, type SnapshotSources } from "./snapshot.ts";

const source = (cents: number, invoices: number) => ({ revenueCents: cents, revenue: "", invoices });

function sources(): SnapshotSources {
  return {
    generatedAt: "2026-11-03T10:00:00.000Z",
    monthly: {
      from: "2026-01",
      to: "2026-02",
      currency: "USD",
      asOf: { date: "2026-10-21", basis: "both" },
      months: [
        { month: "2026-01", revenueCents: 300, revenue: "", invoices: 3, complete: true, bySource: { erpnext: source(100, 1), legacy_unit_b: source(200, 2) } },
        { month: "2026-02", revenueCents: 50, revenue: "", invoices: 1, complete: false, bySource: { erpnext: source(50, 1), legacy_unit_b: source(0, 0) } },
      ],
      total: { revenueCents: 350, revenue: "", invoices: 4, bySource: { erpnext: source(150, 2), legacy_unit_b: source(200, 2) } },
    },
    customers: {
      customers: Array.from({ length: 10 }, (_, i) => ({
        key: `unmapped:legacy_unit_b:raw name ${i}`,
        name: `Customer ${i}`,
        mapped: i % 2 === 0,
        total: { revenueCents: (i + 1) * 100, revenue: "", invoices: i + 1 },
      })),
    },
    quarantine: {
      count: 2,
      byReason: [{ reasonCode: "TOTAL_MISMATCH", count: 2 }],
      entries: [
        { source: "legacy_unit_b", sourceDocId: "UB-26010", reasonCode: "TOTAL_MISMATCH", detail: "see https://x.frappe.cloud a@b.com", sourceCustomer: "eyJhbGci", firstRejectedAt: "t", lastRejectedAt: "t" },
        { source: "erpnext", sourceDocId: "ACC-SINV-1", reasonCode: "TOTAL_MISMATCH", detail: null, sourceCustomer: null, firstRejectedAt: "t", lastRejectedAt: "t" },
      ],
    },
    freshness: {
      erpnext: {
        lastSuccessfulSync: "2026-10-21T15:00:00Z",
        lastRun: { status: "failed", startedAt: "2026-11-03T09:55:00Z", finishedAt: null, error: "ECONNREFUSED 10.0.0.1 erpnext-x.l.frappe.cloud" },
      },
      legacyUnitB: { available: true, newestExportDate: "2026-10-17", lastSuccessfulIngest: "2026-10-19T12:00:00Z" },
      consumer: { lastRunAt: "2026-11-03T09:59:00Z", processed: 197, parked: 0, oldestMessageAge: null },
      queue: { available: true, pending: 0, oldestPendingAgeSeconds: null, deadLetterQueueLength: 0 },
      deadLetter: { count: 0 },
      reconciliation: {
        lastSucceeded: { id: "uuid-1", startedAt: "2026-10-21T06:00:00Z", finishedAt: "2026-10-21T06:00:05Z", status: "succeeded", erpTotal: "462664.00", storedTotal: "462664.00", unexplained: 0, error: "postgres://user@db.supabase.co" },
      },
    },
  };
}

describe("toDemoSnapshot", () => {
  it("splits each month by source and keeps the totals", () => {
    const s = toDemoSnapshot(sources());
    expect(s.months).toEqual([
      { month: "2026-01", erpnextCents: 100, legacyCents: 200, totalCents: 300, invoices: 3, complete: true },
      { month: "2026-02", erpnextCents: 50, legacyCents: 0, totalCents: 50, invoices: 1, complete: false },
    ]);
    expect(s.total).toEqual({ erpnextCents: 150, legacyCents: 200, totalCents: 350, invoices: 4 });
    expect(s.asOfDate).toBe("2026-10-21");
  });

  it("keeps only the top 8 customers by revenue, without their keys", () => {
    const s = toDemoSnapshot(sources());
    expect(s.topCustomers).toHaveLength(8);
    expect(s.topCustomers[0]).toEqual({ name: "Customer 9", totalCents: 1000, invoices: 10, mapped: false });
    expect(JSON.stringify(s.topCustomers)).not.toContain("unmapped:");
  });

  it("keeps quarantine counts and examples without detail or raw customer text", () => {
    const s = toDemoSnapshot(sources());
    expect(s.quarantine.count).toBe(2);
    expect(s.quarantine.byReason).toEqual([{ reasonCode: "TOTAL_MISMATCH", count: 2 }]);
    expect(s.quarantine.examples[0]).toEqual({ source: "legacy_unit_b", sourceDocId: "UB-26010", reasonCode: "TOTAL_MISMATCH" });
  });

  it("builds health from the last good state, with no error text or ids", () => {
    const s = toDemoSnapshot(sources());
    expect(s.health).toEqual({
      erpnextLastSuccessfulSync: "2026-10-21T15:00:00Z",
      legacyNewestExport: "2026-10-17",
      legacyLastIngest: "2026-10-19T12:00:00Z",
      consumerProcessed: 197,
      consumerParked: 0,
      queuePending: 0,
      deadLetter: 0,
      reconciliation: { finishedAt: "2026-10-21T06:00:05Z", erpTotal: "462664.00", storedTotal: "462664.00", unexplained: 0 },
    });
  });

  it("leaks no host, address, email or token anywhere", () => {
    expect(JSON.stringify(toDemoSnapshot(sources()))).not.toMatch(LEAK_PATTERN);
  });

  it("handles an empty quarantine and no successful reconciliation", () => {
    const input = sources();
    input.quarantine = { count: 0, byReason: [], entries: [] };
    input.freshness.reconciliation.lastSucceeded = null;
    const s = toDemoSnapshot(input);
    expect(s.quarantine.examples).toEqual([]);
    expect(s.health.reconciliation).toBeNull();
  });
});

describe("LEAK_PATTERN", () => {
  it.each(["a@b.com", "https://x.io", "10.0.0.1", "db.supabase.co", "pooler.supabase.com", "frappe", "eyJhbGci", "prj_abc", "figueiredofelipes"])(
    "matches %s",
    (text) => expect(text).toMatch(LEAK_PATTERN),
  );
});
