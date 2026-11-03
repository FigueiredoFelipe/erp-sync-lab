// BR08 version 4: a customer's trend from its whole stored monthly history (both sources combined)
// and an as-of date (SPEC BR08; PLAN "Revenue and trends"). Pure, integer cents, no rounding.
import { monthFromIndex, monthIndex, type IsoDate, type YearMonth } from "../as-of.ts";

export type TrendLabel = "churned" | "new" | "growing" | "declining" | "stable";

// Which BR08 rule decided, in the spec's order (3 is the "previous 3 ≤ 0" branch).
export type TrendRule = 1 | 2 | 3 | 4 | 5 | 6;

export interface Trend {
  label: TrendLabel;
  rule: TrendRule;
  // Net revenue of the previous 3 and the last 3 complete months, in cents.
  prev3Cents: number;
  last3Cents: number;
  // The last complete month at the as-of date, and the two windows compared.
  lastCompleteMonth: YearMonth;
  last3: [YearMonth, YearMonth];
  prev3: [YearMonth, YearMonth];
}

// Growth threshold (Q2): 15%, written as integer factors so the comparison is exact.
const UP = 115;
const DOWN = 85;

// `monthlyCents`: net revenue per calendar month ("YYYY-MM" -> integer cents), the customer's whole
// stored history; missing months are zero. `asOfDate`: BR08 as-of date ("YYYY-MM-DD").
export function trend(monthlyCents: ReadonlyMap<YearMonth, number>, asOfDate: IsoDate): Trend {
  const byIndex = new Map<number, number>();
  for (const [month, cents] of monthlyCents) {
    if (!Number.isSafeInteger(cents)) throw new Error(`Revenue for ${month} must be integer cents, got ${cents}`);
    byIndex.set(monthIndex(month), (byIndex.get(monthIndex(month)) ?? 0) + cents);
  }
  const revenue = (index: number) => byIndex.get(index) ?? 0;
  const hasRevenue = (index: number) => revenue(index) > 0;
  const sum = (from: number, to: number) => {
    let total = 0;
    for (let index = from; index <= to; index++) total += revenue(index);
    return total;
  };

  // Complete month: its last day is before the as-of date. The as-of date's own month never is
  // (its last day is on or after the as-of date), so the last complete month is the one before it.
  const last = monthIndex(asOfDate.slice(0, 7)) - 1;
  const prev3Cents = sum(last - 5, last - 3);
  const last3Cents = sum(last - 2, last);
  const base = {
    prev3Cents,
    last3Cents,
    lastCompleteMonth: monthFromIndex(last),
    last3: [monthFromIndex(last - 2), monthFromIndex(last)] as [YearMonth, YearMonth],
    prev3: [monthFromIndex(last - 5), monthFromIndex(last - 3)] as [YearMonth, YearMonth],
  };

  const withRevenue = [...byIndex.keys()].filter(hasRevenue);

  // 1. churned: revenue in some complete month before the last 2, and none in the last 2.
  if (withRevenue.some((index) => index < last - 1) && !hasRevenue(last - 1) && !hasRevenue(last)) {
    return { label: "churned", rule: 1, ...base };
  }
  // 2. new: the first month with revenue in the stored data is one of the last 3.
  const first = withRevenue.length > 0 ? Math.min(...withRevenue) : undefined;
  if (first !== undefined && first >= last - 2 && first <= last) {
    return { label: "new", rule: 2, ...base };
  }
  // 3. previous 3 ≤ 0: growing when the last 3 are > 0, otherwise stable (no division, no base).
  if (prev3Cents <= 0) {
    return { label: last3Cents > 0 ? "growing" : "stable", rule: 3, ...base };
  }
  // 4. growing: last 3 > previous 3 × 1.15.
  if (last3Cents * 100 > prev3Cents * UP) return { label: "growing", rule: 4, ...base };
  // 5. declining: last 3 < previous 3 × 0.85.
  if (last3Cents * 100 < prev3Cents * DOWN) return { label: "declining", rule: 5, ...base };
  // 6. stable.
  return { label: "stable", rule: 6, ...base };
}
