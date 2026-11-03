// revenueService: monthly revenue from public.monthly_revenue (which reads only public.invoice).
// Runtime-agnostic: receives a supabase-js client; never reads the environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCompleteMonth, type AsOf } from "../core/as-of.ts";
import { SOURCE_IDS, type SourceId } from "../core/canonical.ts";
import { centsToDecimal, toCents } from "../core/money.ts";
import { readAsOf } from "./as-of-service.ts";

// A calendar month as "YYYY-MM".
export type YearMonth = string;

export interface MonthRange {
  from: YearMonth;
  to: YearMonth;
}

export interface SourceRevenue {
  revenueCents: number;
  revenue: string;
  invoices: number;
}

export interface MonthRevenue {
  month: YearMonth;
  revenueCents: number;
  revenue: string;
  invoices: number;
  // R19: the month split by source; every source in SOURCE_IDS is always present (zero when it has no
  // invoices), and the parts add up to revenueCents and invoices.
  bySource: Record<SourceId, SourceRevenue>;
  // T10c: false when the month's last day is not before the as-of date (BR08 "complete month"),
  // so the dashboard can mark it instead of letting half a month look like a whole one.
  complete: boolean;
}

export interface MonthlyRevenue {
  from: YearMonth;
  to: YearMonth;
  currency: "USD";
  asOf: AsOf;
  months: MonthRevenue[];
  // R20: the period's total, also split by source (every source always present; the parts add up).
  total: { revenueCents: number; revenue: string; invoices: number; bySource: Record<SourceId, SourceRevenue> };
}

export interface RevenueServiceOptions {
  now?: () => Date;
}

interface ViewRow {
  month: string;
  source: string;
  revenue: number | string;
  invoices: number;
}

function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value);
}

function emptyBuckets(): Record<SourceId, { cents: number; invoices: number }> {
  return Object.fromEntries(SOURCE_IDS.map((source) => [source, { cents: 0, invoices: 0 }])) as Record<
    SourceId,
    { cents: number; invoices: number }
  >;
}

// Every month from `from` to `to`, inclusive.
export function monthsBetween(range: MonthRange): YearMonth[] {
  const [fromYear, fromMonth] = range.from.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = range.to.split("-").map(Number) as [number, number];
  const months: YearMonth[] = [];
  for (let index = fromYear * 12 + fromMonth - 1; index <= toYear * 12 + toMonth - 1; index++) {
    months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

export function createRevenueService(client: SupabaseClient, options: RevenueServiceOptions = {}) {
  const now = options.now ?? (() => new Date());
  return {
    // Revenue per month in the range, all sources combined and split by source (R19); months without
    // invoices come back as zero.
    async getMonthlyRevenue(range: MonthRange): Promise<MonthlyRevenue> {
      // The view and the as-of dates are independent: read together (R17), both awaited before throwing.
      const [view, asOfRead] = await Promise.allSettled([
        client
          .from("monthly_revenue")
          .select("month, source, revenue, invoices")
          .gte("month", `${range.from}-01`)
          .lte("month", `${range.to}-01`),
        readAsOf(client, now()),
      ]);
      if (view.status === "rejected") throw view.reason;
      const { data, error } = view.value;
      if (error) throw new Error(`monthly_revenue query failed: ${error.message}`);
      if (asOfRead.status === "rejected") throw asOfRead.reason;
      const asOf = asOfRead.value;

      const byMonth = new Map<YearMonth, Record<SourceId, { cents: number; invoices: number }>>(
        monthsBetween(range).map((month) => [month, emptyBuckets()]),
      );
      for (const row of (data ?? []) as ViewRow[]) {
        // Fail-closed (R19): a source outside the canonical list would make the segments not add up. Checked
        // before the range filter, so an unknown source is never hidden by a row outside the range.
        if (!isSourceId(row.source)) throw new Error(`monthly_revenue returned an unknown source: ${row.source}`);
        const buckets = byMonth.get(row.month.slice(0, 7));
        if (!buckets) continue;
        buckets[row.source].cents += toCents(row.revenue);
        buckets[row.source].invoices += row.invoices;
      }

      const months = [...byMonth].map(([month, buckets]): MonthRevenue => {
        const cents = SOURCE_IDS.reduce((sum, source) => sum + buckets[source].cents, 0);
        const invoices = SOURCE_IDS.reduce((sum, source) => sum + buckets[source].invoices, 0);
        return {
          month,
          revenueCents: cents,
          revenue: centsToDecimal(cents),
          invoices,
          bySource: Object.fromEntries(
            SOURCE_IDS.map((source) => [
              source,
              { revenueCents: buckets[source].cents, revenue: centsToDecimal(buckets[source].cents), invoices: buckets[source].invoices },
            ]),
          ) as Record<SourceId, SourceRevenue>,
          complete: isCompleteMonth(month, asOf.date),
        };
      });
      const totalCents = months.reduce((sum, month) => sum + month.revenueCents, 0);
      const totalBySource = Object.fromEntries(
        SOURCE_IDS.map((source) => {
          const cents = months.reduce((sum, month) => sum + month.bySource[source].revenueCents, 0);
          const invoices = months.reduce((sum, month) => sum + month.bySource[source].invoices, 0);
          return [source, { revenueCents: cents, revenue: centsToDecimal(cents), invoices }];
        }),
      ) as Record<SourceId, SourceRevenue>;
      return {
        from: range.from,
        to: range.to,
        currency: "USD",
        asOf,
        months,
        total: {
          revenueCents: totalCents,
          revenue: centsToDecimal(totalCents),
          invoices: months.reduce((sum, month) => sum + month.invoices, 0),
          bySource: totalBySource,
        },
      };
    },
  };
}

export type RevenueService = ReturnType<typeof createRevenueService>;
