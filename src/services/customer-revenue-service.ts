// customerRevenueService: monthly revenue per customer (R08, BR07, US02), from public.customer_monthly_revenue,
// which reads only public.invoice. Runtime-agnostic: receives a supabase-js client and a clock.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isCompleteMonth, type AsOf } from "../core/as-of.ts";
import { centsToDecimal, toCents } from "../core/money.ts";
import { trend, type Trend } from "../core/trend/trend.ts";
import { readAsOf } from "./as-of-service.ts";
import { monthsBetween, type MonthRange, type YearMonth } from "./revenue-service.ts";

export const SOURCES = ["erpnext", "legacy_unit_b"] as const;
export type Source = (typeof SOURCES)[number];

export interface CustomerRevenueFilters {
  range: MonthRange;
  source: Source | null;
  // A customer key as the view exposes it: the canonical id, or "unmapped:<source>:<source customer>".
  customer: string | null;
}

export interface CustomerMonth {
  month: YearMonth;
  revenueCents: number;
  revenue: string;
  invoices: number;
}

export interface CustomerRevenueRow {
  key: string;
  name: string;
  mapped: boolean;
  months: CustomerMonth[];
  total: { revenueCents: number; revenue: string; invoices: number };
  // BR08 trend over the customer's whole stored history, both sources, whatever the filters (T20).
  trend: Trend;
}

export interface CustomerOption {
  key: string;
  name: string;
  mapped: boolean;
}

export interface CustomerRevenue {
  from: YearMonth;
  to: YearMonth;
  source: Source | null;
  customer: string | null;
  currency: "USD";
  asOf: AsOf;
  // Each month's total over the listed customers, and whether the month is complete at the as-of date.
  months: { month: YearMonth; complete: boolean; revenueCents: number; revenue: string; invoices: number }[];
  customers: CustomerRevenueRow[];
  // Every customer with revenue in any month or source, for the filter, independent of the filters.
  customerOptions: CustomerOption[];
  total: { revenueCents: number; revenue: string; invoices: number };
}

export interface ViewRow {
  month: string;
  source: string;
  customer_key: string;
  customer_name: string;
  mapped: boolean;
  revenue: number | string;
  invoices: number;
}

const VIEW = "customer_monthly_revenue";
const COLUMNS = "month, source, customer_key, customer_name, mapped, revenue, invoices";

// PostgREST caps a response (max-rows); a silently truncated sum would be a wrong figure, so refuse it.
function ensureComplete(rows: unknown[] | null, count: number | null, what: string): void {
  if (typeof count === "number" && (rows?.length ?? 0) < count) {
    throw new Error(`${what}: got ${rows?.length ?? 0} of ${count} rows; refusing a partial sum`);
  }
}

// BR07 per customer: sums the view rows (one per month and source) into each customer's months, in cents.
export function aggregateByCustomer(rows: ViewRow[], months: YearMonth[]): Omit<CustomerRevenueRow, "trend">[] {
  const byCustomer = new Map<string, Omit<CustomerRevenueRow, "trend"> & { byMonth: Map<YearMonth, CustomerMonth> }>();
  for (const row of rows) {
    const month = row.month.slice(0, 7);
    let customer = byCustomer.get(row.customer_key);
    if (!customer) {
      customer = {
        key: row.customer_key,
        name: row.customer_name,
        mapped: row.mapped,
        months: [],
        total: { revenueCents: 0, revenue: "0.00", invoices: 0 },
        byMonth: new Map(months.map((m) => [m, { month: m, revenueCents: 0, revenue: "0.00", invoices: 0 }])),
      };
      byCustomer.set(row.customer_key, customer);
    }
    const bucket = customer.byMonth.get(month);
    if (!bucket) continue;
    bucket.revenueCents += toCents(row.revenue);
    bucket.invoices += row.invoices;
  }

  const result = [...byCustomer.values()].map(({ byMonth, ...customer }) => {
    const customerMonths = [...byMonth.values()].map((m) => ({ ...m, revenue: centsToDecimal(m.revenueCents) }));
    const cents = customerMonths.reduce((sum, m) => sum + m.revenueCents, 0);
    return {
      ...customer,
      months: customerMonths,
      total: { revenueCents: cents, revenue: centsToDecimal(cents), invoices: customerMonths.reduce((sum, m) => sum + m.invoices, 0) },
    };
  });
  // Largest customers first; ties by name, so the order is stable.
  return result.sort((a, b) => b.total.revenueCents - a.total.revenueCents || a.name.localeCompare(b.name));
}

// Each customer's whole history as "YYYY-MM" -> cents, every source added together (BR08 input).
export function historyByCustomer(rows: ViewRow[]): Map<string, Map<YearMonth, number>> {
  const result = new Map<string, Map<YearMonth, number>>();
  for (const row of rows) {
    const months = result.get(row.customer_key) ?? new Map<YearMonth, number>();
    const month = row.month.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + toCents(row.revenue));
    result.set(row.customer_key, months);
  }
  return result;
}

// The rows the filters select, as the SQL filter did: month "YYYY-MM" within [from, to] inclusive,
// exact source, exact customer key. The trend and the customer options keep using every row.
export function filterRows(rows: ViewRow[], filters: CustomerRevenueFilters): ViewRow[] {
  const { from, to } = filters.range;
  return rows.filter((row) => {
    const month = row.month.slice(0, 7);
    if (month < from || month > to) return false;
    if (filters.source && row.source !== filters.source) return false;
    if (filters.customer && row.customer_key !== filters.customer) return false;
    return true;
  });
}

export function customerOptions(rows: ViewRow[]): CustomerOption[] {
  const options = new Map<string, CustomerOption>();
  for (const row of rows) {
    if (!options.has(row.customer_key)) options.set(row.customer_key, { key: row.customer_key, name: row.customer_name, mapped: row.mapped });
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export interface CustomerRevenueServiceOptions {
  now?: () => Date;
}

export function createCustomerRevenueService(client: SupabaseClient, options: CustomerRevenueServiceOptions = {}) {
  const now = options.now ?? (() => new Date());

  // The whole stored history, every source: the filtered figures, the filter options and the trend (BR08).
  // Past PostgREST's max-rows, ensureComplete refuses it (fail-closed) rather than sum part of it.
  async function readHistory(): Promise<ViewRow[]> {
    const { data, error, count } = await client.from(VIEW).select(COLUMNS, { count: "exact" }).order("month");
    if (error) throw new Error(`${VIEW} query failed: ${error.message}`);
    ensureComplete(data, count, VIEW);
    return (data ?? []) as ViewRow[];
  }

  return {
    readHistory,

    async getCustomerRevenue(filters: CustomerRevenueFilters): Promise<CustomerRevenue> {
      // One read of the whole history, together with the as-of dates (R17); both awaited before throwing.
      const [historyRead, asOfRead] = await Promise.allSettled([readHistory(), readAsOf(client, now())]);
      if (historyRead.status === "rejected") throw historyRead.reason;
      if (asOfRead.status === "rejected") throw asOfRead.reason;
      const history = historyRead.value;
      const asOf = asOfRead.value;
      const months = monthsBetween(filters.range);
      const histories = historyByCustomer(history);
      // Filter before aggregating, so a customer with revenue only outside the filters is not listed.
      const customers: CustomerRevenueRow[] = aggregateByCustomer(filterRows(history, filters), months).map((customer) => ({
        ...customer,
        trend: trend(histories.get(customer.key) ?? new Map(), asOf.date),
      }));
      const totalCents = customers.reduce((sum, c) => sum + c.total.revenueCents, 0);

      return {
        from: filters.range.from,
        to: filters.range.to,
        source: filters.source,
        customer: filters.customer,
        currency: "USD",
        asOf,
        months: months.map((month, index) => {
          const cents = customers.reduce((sum, c) => sum + (c.months[index]?.revenueCents ?? 0), 0);
          return {
            month,
            complete: isCompleteMonth(month, asOf.date),
            revenueCents: cents,
            revenue: centsToDecimal(cents),
            invoices: customers.reduce((sum, c) => sum + (c.months[index]?.invoices ?? 0), 0),
          };
        }),
        customers,
        customerOptions: customerOptions(history),
        total: {
          revenueCents: totalCents,
          revenue: centsToDecimal(totalCents),
          invoices: customers.reduce((sum, c) => sum + c.total.invoices, 0),
        },
      };
    },
  };
}

export type CustomerRevenueService = ReturnType<typeof createCustomerRevenueService>;
