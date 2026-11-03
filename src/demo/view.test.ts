import { describe, expect, it } from "@jest/globals";
import type { DemoSnapshot } from "./snapshot.ts";
import { buildDemoView } from "./view.ts";

const snapshot: DemoSnapshot = {
  generatedAt: "2026-11-03T10:00:00.000Z",
  asOfDate: "2026-10-16",
  months: [
    { month: "2026-01", erpnextCents: 100_00, legacyCents: 50_00, totalCents: 150_00, invoices: 3, complete: true },
    { month: "2026-10", erpnextCents: 10_00, legacyCents: 0, totalCents: 10_00, invoices: 1, complete: false },
  ],
  total: { erpnextCents: 110_00, legacyCents: 50_00, totalCents: 160_00, invoices: 4 },
  topCustomers: [{ name: "Acme Foods Inc.", totalCents: 160_00, invoices: 4, mapped: true }],
  quarantine: { count: 2, byReason: [{ reasonCode: "TOTAL_MISMATCH", count: 2 }], examples: [{ source: "legacy_unit_b", sourceDocId: "UB-26010", reasonCode: "TOTAL_MISMATCH" }] },
  health: {
    erpnextLastSuccessfulSync: "2026-11-01T19:30:01Z",
    legacyNewestExport: "2026-10-16",
    legacyLastIngest: "2026-10-18T20:00:01Z",
    consumerProcessed: 0,
    consumerParked: 0,
    queuePending: 0,
    deadLetter: 0,
    reconciliation: { finishedAt: "2026-11-01T06:00:02Z", erpTotal: "462664", storedTotal: "462664", unexplained: 0 },
  },
};

describe("buildDemoView", () => {
  it("labels months and formats money", () => {
    const view = buildDemoView(snapshot);
    expect(view.months[0]).toEqual({ label: "Jan 2026", short: "Jan", erpnextCents: 100_00, legacyCents: 50_00, totalCents: 150_00, erpnext: "$100.00", legacy: "$50.00", total: "$150.00", invoices: 3, partial: false });
    expect(view.maxMonthCents).toBe(150_00);
    expect(view.months[1]?.partial).toBe(true);
    expect(view.total).toEqual({ erpnext: "$110.00", legacy: "$50.00", total: "$160.00", invoices: 4 });
  });

  it("states the snapshot date and the as-of date", () => {
    const view = buildDemoView(snapshot);
    expect(view.frozenOn).toBe("Nov 3, 2026");
    expect(view.asOf).toBe("Oct 16, 2026");
  });

  it("describes reconciliation as matched when nothing is unexplained", () => {
    expect(buildDemoView(snapshot).reconciliation).toBe("ERPNext $462,664.00 = stored $462,664.00, 0 unexplained");
    expect(buildDemoView(snapshot).reconciled).toBe(true);
  });

  it("says when no reconciliation has succeeded", () => {
    const none = buildDemoView({ ...snapshot, health: { ...snapshot.health, reconciliation: null } });
    expect(none.reconciliation).toBe("No successful run in this snapshot");
    expect(none.reconciled).toBe(false);
  });

  it("gives readable quarantine reasons", () => {
    expect(buildDemoView(snapshot).quarantine).toEqual([{ reason: "Total mismatch", code: "TOTAL_MISMATCH", count: 2 }]);
  });
});
