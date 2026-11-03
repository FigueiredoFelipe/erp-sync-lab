// Comparing figures across screens (R20, AC34–AC37; PLAN "Financial clarity between Sync health and Revenue").
// Pure functions, no runtime-specific APIs.
//
// The reconciliation (R14) checks ERPNext (Unit A) against the ERPNext records we stored. Its stored total
// can be shown as matching the current ERPNext valid revenue only when both cover the same period and the
// two agree to the cent; otherwise the screen says why they are not compared. Unit B never enters here.
import { toCents } from "../money.ts";
import { lastDayOfMonth, type IsoDate, type YearMonth } from "../as-of.ts";

// A period of whole days, inclusive: { from: "2026-01-01", to: "2026-12-31" }.
export interface DatePeriod {
  from: IsoDate;
  to: IsoDate;
}

// The last successful reconciliation run, as far as the comparison needs it.
export interface ComparedRun {
  period: DatePeriod;
  startedAt: string;
  storedTotal: string | null;
}

export type Comparison =
  // Same period, and the current ERPNext valid revenue equals the run's stored total to the cent.
  | { result: "matches"; erpnextValidCents: number; storedTotalCents: number; runStartedAt: string }
  // The run covers another period than the figure: never compared.
  | { result: "different-period"; erpnextValidCents: number; breakdownPeriod: DatePeriod; runPeriod: DatePeriod }
  // Same period, but ERPNext data changed since the run started (or the run stored no total).
  | { result: "changed-since-run"; erpnextValidCents: number; storedTotalCents: number | null; runStartedAt: string }
  // No reconciliation run has ever succeeded.
  | { result: "no-successful-run"; erpnextValidCents: number };

// What the freshness service reports: the comparison, or "unavailable" when the current ERPNext figure could
// not be read (the rest of the answer still loads; nothing is compared).
export type ReconciliationComparison = Comparison | { result: "unavailable" };

export interface CompareInput {
  // The period of erpnextValidCents.
  breakdownPeriod: DatePeriod;
  // Current ERPNext (Unit A) valid revenue for breakdownPeriod, in cents (sum of public.invoice amounts).
  erpnextValidCents: number;
  // The last succeeded run (never a running or failed one, Q11); null when none succeeded.
  run: ComparedRun | null;
}

const samePeriod = (a: DatePeriod, b: DatePeriod) => a.from === b.from && a.to === b.to;

// Business rule (AC35, AC37): whether the breakdown's ERPNext figure may be shown as matching the
// reconciliation's stored total. Fail-closed: anything short of "same period, equal to the cent" is not a match.
export function compareWithReconciliation(input: CompareInput): Comparison {
  const { breakdownPeriod, erpnextValidCents, run } = input;
  if (run === null) return { result: "no-successful-run", erpnextValidCents };
  if (!samePeriod(breakdownPeriod, run.period)) {
    return { result: "different-period", erpnextValidCents, breakdownPeriod, runPeriod: run.period };
  }
  const storedTotalCents = run.storedTotal === null ? null : toCents(run.storedTotal);
  if (storedTotalCents === erpnextValidCents) {
    return { result: "matches", erpnextValidCents, storedTotalCents, runStartedAt: run.startedAt };
  }
  return { result: "changed-since-run", erpnextValidCents, storedTotalCents, runStartedAt: run.startedAt };
}

// What a figure's period label states (PLAN "Period label"): its first and last month and, when the as-of
// date falls inside the period, the date the data runs through and the as-of month, which is partial.
// Months after the as-of month hold no data yet and are not called partial.
export interface PeriodCoverage {
  firstMonth: YearMonth;
  lastMonth: YearMonth;
  dataThrough: IsoDate | null;
  partialMonth: YearMonth | null;
}

export function periodCoverage(period: { from: YearMonth; to: YearMonth }, asOf: IsoDate): PeriodCoverage {
  const asOfMonth = asOf.slice(0, 7);
  const inside = asOfMonth >= period.from && asOfMonth <= period.to;
  return {
    firstMonth: period.from,
    lastMonth: period.to,
    dataThrough: inside ? asOf : null,
    partialMonth: inside ? asOfMonth : null,
  };
}

// The months of a whole-month date period: { from: "2026-01-01", to: "2026-12-31" } -> 2026-01 .. 2026-12.
// Throws when the period does not start on a first or end on a last day of a month: a monthly figure
// can't cover it exactly.
export function monthsOfPeriod(period: DatePeriod): { from: YearMonth; to: YearMonth } {
  const from = period.from.slice(0, 7);
  const to = period.to.slice(0, 7);
  if (!period.from.endsWith("-01") || period.to !== lastDayOfMonth(to)) {
    throw new Error(`Not a whole-month period: ${period.from} to ${period.to}`);
  }
  return { from, to };
}

// The breakdown as the Sync health page loaded it: its months (data.from/data.to of the breakdown response)
// and its ERPNext (Unit A) part, in cents.
export interface LoadedBreakdown {
  from: YearMonth;
  to: YearMonth;
  erpnextCents: number;
}

// The reconciliation as the freshness response reported it.
export interface ReportedReconciliation {
  period: DatePeriod;
  comparison: ReconciliationComparison;
}

export type BreakdownComparison =
  | ReconciliationComparison
  // The breakdown and the freshness answer saw different ERPNext figures (the two requests raced a change).
  | { result: "changed-while-loading"; erpnextValidCents: number; breakdownErpnextCents: number };

// Business rule (AC35): what the Sync health page may say about its breakdown against the reconciliation.
// The breakdown and the comparison come from two requests, so the service's verdict holds only when the
// breakdown covers the reconciliation's period and saw the same ERPNext figure the service compared;
// anything else is "not compared" (fail-closed).
export function reconcileBreakdownWithComparison(breakdown: LoadedBreakdown, reconciliation: ReportedReconciliation): BreakdownComparison {
  const { comparison, period } = reconciliation;
  if (comparison.result === "unavailable" || comparison.result === "no-successful-run") return comparison;
  const breakdownPeriod: DatePeriod = { from: `${breakdown.from}-01`, to: lastDayOfMonth(breakdown.to) };
  if (!samePeriod(breakdownPeriod, period)) {
    return { result: "different-period", erpnextValidCents: breakdown.erpnextCents, breakdownPeriod, runPeriod: period };
  }
  if (comparison.erpnextValidCents !== breakdown.erpnextCents) {
    return { result: "changed-while-loading", erpnextValidCents: comparison.erpnextValidCents, breakdownErpnextCents: breakdown.erpnextCents };
  }
  return comparison;
}
