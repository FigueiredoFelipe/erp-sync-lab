// The as-of date of the figures (SPEC BR08 "As-of date"; PLAN "Revenue and trends") and the
// complete-month rule that both the partial-month marking (T10c) and the trend (T20) use.
// Pure functions over ISO dates ("YYYY-MM-DD") and months ("YYYY-MM"); no runtime-specific APIs.

export type IsoDate = string;
export type YearMonth = string;

export type AsOfBasis = "both" | "erpnext" | "legacy_unit_b" | "today";

export interface AsOf {
  date: IsoDate;
  // Which inputs decided the date: both sources (the earlier wins), only one of them, or neither (today).
  basis: AsOfBasis;
}

export interface AsOfInput {
  // Date of Source A's last successful sync, already in the business time zone.
  erpnextLastSync: IsoDate | null;
  // Export date of the newest ingested Source B file (from its file name).
  sourceBNewestExport: IsoDate | null;
  // Fallback when no source has data yet.
  today: IsoDate;
}

// BR08: the earlier of Source A's last successful sync date and the newest Source B export date.
// With only one of them, that one; with neither, today.
export function asOfDate(input: AsOfInput): AsOf {
  const { erpnextLastSync: a, sourceBNewestExport: b } = input;
  if (a && b) return { date: a < b ? a : b, basis: "both" };
  if (a) return { date: a, basis: "erpnext" };
  if (b) return { date: b, basis: "legacy_unit_b" };
  return { date: input.today, basis: "today" };
}

// Calendar date of an instant in a time zone, as "YYYY-MM-DD". The business runs on US Eastern time,
// the same zone the dashboard prints timestamps in.
export function dateInZone(instant: string | Date, timeZone = "America/New_York"): IsoDate {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid instant: ${String(instant)}`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Last calendar day of a month, "YYYY-MM-DD".
export function lastDayOfMonth(month: YearMonth): IsoDate {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

// BR08 "Complete month": a calendar month whose last day is before the as-of date.
export function isCompleteMonth(month: YearMonth, asOf: IsoDate): boolean {
  return lastDayOfMonth(month) < asOf;
}

// Months as an integer index (year * 12 + month - 1) and back, for month arithmetic.
export function monthIndex(month: YearMonth): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

export function monthFromIndex(index: number): YearMonth {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
