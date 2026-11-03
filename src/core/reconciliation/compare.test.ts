import { describe, expect, it } from "@jest/globals";
import {
  compareWithReconciliation,
  monthsOfPeriod,
  periodCoverage,
  reconcileBreakdownWithComparison,
  type ComparedRun,
  type CompareInput,
  type Comparison,
} from "./compare.ts";

const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const RUN: ComparedRun = { period: YEAR, startedAt: "2026-10-19T06:00:00Z", storedTotal: "462664.00" };

describe("compareWithReconciliation (R20, AC35, AC37)", () => {
  it("matches when the period is the same and the current ERPNext figure equals the stored total to the cent", () => {
    expect(compareWithReconciliation({ breakdownPeriod: YEAR, erpnextValidCents: 46266400, run: RUN })).toEqual({
      result: "matches",
      erpnextValidCents: 46266400,
      storedTotalCents: 46266400,
      runStartedAt: "2026-10-19T06:00:00Z",
    });
  });

  it("does not match when one cent differs: ERPNext data changed since the run started", () => {
    expect(compareWithReconciliation({ breakdownPeriod: YEAR, erpnextValidCents: 46266401, run: RUN })).toEqual({
      result: "changed-since-run",
      erpnextValidCents: 46266401,
      storedTotalCents: 46266400,
      runStartedAt: "2026-10-19T06:00:00Z",
    });
  });

  it("never compares across periods, even when the figures happen to be equal", () => {
    const breakdownPeriod = { from: "2026-01-01", to: "2026-10-31" };
    expect(compareWithReconciliation({ breakdownPeriod, erpnextValidCents: 46266400, run: RUN })).toEqual({
      result: "different-period",
      erpnextValidCents: 46266400,
      breakdownPeriod,
      runPeriod: YEAR,
    });
  });

  it("offers no comparison when no run has succeeded", () => {
    expect(compareWithReconciliation({ breakdownPeriod: YEAR, erpnextValidCents: 100, run: null })).toEqual({
      result: "no-successful-run",
      erpnextValidCents: 100,
    });
  });

  it("is not a match when the run stored no total (fail-closed)", () => {
    expect(compareWithReconciliation({ breakdownPeriod: YEAR, erpnextValidCents: 0, run: { ...RUN, storedTotal: null } })).toMatchObject({
      result: "changed-since-run",
      storedTotalCents: null,
    });
  });

  // The caller passes the last succeeded run, whatever the latest run's state (Q11): a running or failed
  // latest run has no say, so its outcome is the previous success's.
  it.each([
    ["running", 46266400, "matches"],
    ["failed", 46266400, "matches"],
    ["running", 46000000, "changed-since-run"],
    ["failed", 46000000, "changed-since-run"],
  ])("uses the previous successful run when the latest one is %s", (_latest, cents, expected) => {
    expect(compareWithReconciliation({ breakdownPeriod: YEAR, erpnextValidCents: cents, run: RUN }).result).toBe(expected);
  });

  it("takes no Unit B input, so a change in Unit B data leaves the result unchanged", () => {
    const input: CompareInput = { breakdownPeriod: YEAR, erpnextValidCents: 46266400, run: RUN };
    const before = compareWithReconciliation(input);
    // The breakdown's Unit B part and sum moving (e.g. a new export) is not part of the input at all.
    const withUnitB = { ...input, legacyUnitBCents: 10991583, totalCents: 57258223 } as CompareInput;
    expect(compareWithReconciliation(withUnitB)).toEqual(before);
    expect(Object.keys(input).sort()).toEqual(["breakdownPeriod", "erpnextValidCents", "run"]);
  });
});

describe("periodCoverage (period label)", () => {
  it("marks the as-of month partial and states the date the data runs through when it falls inside", () => {
    expect(periodCoverage({ from: "2026-01", to: "2026-12" }, "2026-10-18")).toEqual({
      firstMonth: "2026-01",
      lastMonth: "2026-12",
      dataThrough: "2026-10-18",
      partialMonth: "2026-10",
    });
    expect(periodCoverage({ from: "2026-01", to: "2026-10" }, "2026-10-18").partialMonth).toBe("2026-10");
  });

  it("states no partial month when the as-of date is outside the period", () => {
    expect(periodCoverage({ from: "2026-01", to: "2026-09" }, "2026-10-18")).toEqual({
      firstMonth: "2026-01",
      lastMonth: "2026-09",
      dataThrough: null,
      partialMonth: null,
    });
    expect(periodCoverage({ from: "2026-11", to: "2026-12" }, "2026-10-18").partialMonth).toBeNull();
  });
});

describe("monthsOfPeriod", () => {
  it("turns a whole-month date period into its months", () => {
    expect(monthsOfPeriod(YEAR)).toEqual({ from: "2026-01", to: "2026-12" });
    expect(monthsOfPeriod({ from: "2026-02-01", to: "2026-02-28" })).toEqual({ from: "2026-02", to: "2026-02" });
  });

  it("throws on a period a monthly figure can't cover exactly", () => {
    expect(() => monthsOfPeriod({ from: "2026-01-02", to: "2026-12-31" })).toThrow("Not a whole-month period");
    expect(() => monthsOfPeriod({ from: "2026-01-01", to: "2026-12-30" })).toThrow("Not a whole-month period");
  });
});

describe("reconcileBreakdownWithComparison (AC35: the page's breakdown against the reported comparison)", () => {
  const BREAKDOWN = { from: "2026-01", to: "2026-12", erpnextCents: 46266400 };
  const MATCHES: Comparison = { result: "matches", erpnextValidCents: 46266400, storedTotalCents: 46266400, runStartedAt: RUN.startedAt };
  const CHANGED: Comparison = { result: "changed-since-run", erpnextValidCents: 46266400, storedTotalCents: 46000000, runStartedAt: RUN.startedAt };

  it("keeps the service's verdict when the breakdown covers the same period and saw the same ERPNext figure", () => {
    expect(reconcileBreakdownWithComparison(BREAKDOWN, { period: YEAR, comparison: MATCHES })).toEqual(MATCHES);
    expect(reconcileBreakdownWithComparison(BREAKDOWN, { period: YEAR, comparison: CHANGED })).toEqual(CHANGED);
  });

  it.each([
    ["matches", MATCHES],
    ["changed-since-run", CHANGED],
  ] as [string, Comparison][])("says the figure changed while loading when a %s comparison saw another ERPNext figure", (_name, comparison) => {
    expect(reconcileBreakdownWithComparison({ ...BREAKDOWN, erpnextCents: 46266401 }, { period: YEAR, comparison })).toEqual({
      result: "changed-while-loading",
      erpnextValidCents: 46266400,
      breakdownErpnextCents: 46266401,
    });
  });

  it("runs the stale check on a different-period verdict from the service too", () => {
    const other: Comparison = { result: "different-period", erpnextValidCents: 1, breakdownPeriod: YEAR, runPeriod: YEAR };
    expect(reconcileBreakdownWithComparison(BREAKDOWN, { period: YEAR, comparison: other }).result).toBe("changed-while-loading");
  });

  it("never compares when the breakdown's months differ from the reconciliation's period, even with equal figures", () => {
    expect(reconcileBreakdownWithComparison({ ...BREAKDOWN, to: "2026-10" }, { period: YEAR, comparison: MATCHES })).toEqual({
      result: "different-period",
      erpnextValidCents: 46266400,
      breakdownPeriod: { from: "2026-01-01", to: "2026-10-31" },
      runPeriod: YEAR,
    });
  });

  it("passes no-successful-run and unavailable through without a stale check", () => {
    const none: Comparison = { result: "no-successful-run", erpnextValidCents: 1 };
    expect(reconcileBreakdownWithComparison(BREAKDOWN, { period: YEAR, comparison: none })).toEqual(none);
    expect(reconcileBreakdownWithComparison(BREAKDOWN, { period: YEAR, comparison: { result: "unavailable" } })).toEqual({ result: "unavailable" });
  });
});
