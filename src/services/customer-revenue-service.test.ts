import { describe, expect, it } from "@jest/globals";
import { trend } from "../core/trend/trend.ts";
import { fakeSupabase, issuedNames, type Result } from "../../tests/http/fake-supabase.ts";
import {
  aggregateByCustomer,
  createCustomerRevenueService,
  customerOptions,
  filterRows,
  historyByCustomer,
  type CustomerRevenueFilters,
  type ViewRow,
} from "./customer-revenue-service.ts";
import { monthsBetween } from "./revenue-service.ts";

const row = (month: string, source: string, key: string, revenue: number | string, invoices = 1, name = key, mapped = true): ViewRow => ({
  month: `${month}-01`,
  source,
  customer_key: key,
  customer_name: name,
  mapped,
  revenue,
  invoices,
});

describe("aggregateByCustomer (BR07)", () => {
  it("adds both sources into each customer's month, in cents", () => {
    const result = aggregateByCustomer(
      [row("2026-03", "erpnext", "acme", 1000.1), row("2026-03", "legacy_unit_b", "acme", "200.05", 2)],
      ["2026-03"],
    );
    expect(result).toEqual([
      {
        key: "acme",
        name: "acme",
        mapped: true,
        months: [{ month: "2026-03", revenueCents: 120015, revenue: "1200.15", invoices: 3 }],
        total: { revenueCents: 120015, revenue: "1200.15", invoices: 3 },
      },
    ]);
  });

  it("keeps a credit note negative in its own month (the view groups by invoice date)", () => {
    const [acme] = aggregateByCustomer(
      [row("2026-03", "erpnext", "acme", 500), row("2026-04", "erpnext", "acme", -150)],
      ["2026-03", "2026-04", "2026-05"],
    );
    expect(acme?.months.map((m) => [m.month, m.revenue])).toEqual([
      ["2026-03", "500.00"],
      ["2026-04", "-150.00"],
      ["2026-05", "0.00"],
    ]);
    expect(acme?.total.revenue).toBe("350.00");
  });

  it("fills months without invoices with zero and sorts customers by total, then name", () => {
    const result = aggregateByCustomer(
      [row("2026-01", "erpnext", "b", 10), row("2026-02", "erpnext", "a", 10), row("2026-02", "erpnext", "c", 99)],
      ["2026-01", "2026-02"],
    );
    expect(result.map((c) => c.key)).toEqual(["c", "a", "b"]);
    expect(result[2]?.months).toEqual([
      { month: "2026-01", revenueCents: 1000, revenue: "10.00", invoices: 1 },
      { month: "2026-02", revenueCents: 0, revenue: "0.00", invoices: 0 },
    ]);
  });

  it("lists filter options once per customer key, by name", () => {
    expect(
      customerOptions([
        row("2026-01", "erpnext", "z", 1, 1, "Zeta"),
        row("2026-02", "legacy_unit_b", "z", 1, 1, "Zeta"),
        row("2026-01", "erpnext", "unmapped:erpnext:Alpha", 1, 1, "Alpha", false),
      ]),
    ).toEqual([
      { key: "unmapped:erpnext:Alpha", name: "Alpha", mapped: false },
      { key: "z", name: "Zeta", mapped: true },
    ]);
  });
});

const SOURCES: Record<string, Result> = {
  sync_run: { data: [{ finished_at: "2026-10-18T18:00:00Z" }], error: null },
  source_file: { data: null, error: { message: "Could not find the table 'public.source_file' in the schema cache", code: "PGRST205" } },
};
const NOW = () => new Date("2026-10-18T20:00:00Z");

describe("customerRevenueService.getCustomerRevenue", () => {
  it("reads the whole history once, filters it in memory and returns months with completeness", async () => {
    const { client, calls } = fakeSupabase({
      ...SOURCES,
      customer_monthly_revenue: {
        data: [row("2026-08", "erpnext", "acme", 99), row("2026-10", "legacy_unit_b", "acme", 5), row("2026-10", "erpnext", "acme", 12.34), row("2026-10", "erpnext", "zeta", 7)],
        error: null,
        count: 4,
      },
    });
    const result = await createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({
      range: { from: "2026-09", to: "2026-10" },
      source: "erpnext",
      customer: "acme",
    });
    const views = calls.filter((c) => c.table === "customer_monthly_revenue");
    expect(views).toHaveLength(1);
    expect(views[0]?.chain).toEqual([
      ["select", "month, source, customer_key, customer_name, mapped, revenue, invoices", { count: "exact" }],
      ["order", "month"],
    ]);
    expect(result.months).toEqual([
      { month: "2026-09", complete: true, revenueCents: 0, revenue: "0.00", invoices: 0 },
      { month: "2026-10", complete: false, revenueCents: 1234, revenue: "12.34", invoices: 1 },
    ]);
    expect(result.customers.map((c) => c.key)).toEqual(["acme"]);
    expect(result.total).toEqual({ revenueCents: 1234, revenue: "12.34", invoices: 1 });
    // The options ignore the filters.
    expect(result.customerOptions.map((o) => o.key)).toEqual(["acme", "zeta"]);
  });

  it("refuses a response PostgREST truncated, instead of summing part of it", async () => {
    const { client } = fakeSupabase({
      ...SOURCES,
      customer_monthly_revenue: { data: [row("2026-10", "erpnext", "acme", 1)], error: null, count: 2 } as Result,
    });
    await expect(
      createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({ range: { from: "2026-10", to: "2026-10" }, source: null, customer: null }),
    ).rejects.toThrow("refusing a partial sum");
  });

  it("throws when the view fails", async () => {
    const { client } = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: null, error: { message: "boom" } } });
    await expect(
      createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({ range: { from: "2026-10", to: "2026-10" }, source: null, customer: null }),
    ).rejects.toThrow("boom");
  });

  it("throws when the as-of dates fail", async () => {
    const { client } = fakeSupabase({ ...SOURCES, sync_run: { data: null, error: { message: "down" } }, customer_monthly_revenue: { data: [], error: null } });
    await expect(
      createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({ range: { from: "2026-10", to: "2026-10" }, source: null, customer: null }),
    ).rejects.toThrow("sync_run query failed");
  });
});

describe("customer revenue round trips (R17)", () => {
  const FILTERS: CustomerRevenueFilters = { range: { from: "2026-09", to: "2026-10" }, source: null, customer: null };

  it("reads the history and the as-of dates in one round trip", async () => {
    const fake = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: [row("2026-10", "erpnext", "acme", 1)], error: null } }, {}, { deferred: true });
    const promise = createCustomerRevenueService(fake.client, { now: NOW }).getCustomerRevenue(FILTERS);
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["customer_monthly_revenue", "source_file", "source_file", "sync_run"]);
    fake.releaseAll();
    expect((await promise).total.revenue).toBe("1.00");
  });

  it("waits for the as-of reads before failing on the history", async () => {
    const fake = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: null, error: { message: "boom" } } }, {}, { deferred: true });
    let settled = false;
    const promise = createCustomerRevenueService(fake.client, { now: NOW })
      .getCustomerRevenue(FILTERS)
      .finally(() => {
        settled = true;
      });
    await fake.settle();
    fake.release("customer_monthly_revenue");
    await fake.settle();
    expect(settled).toBe(false);
    fake.releaseAll();
    await expect(promise).rejects.toThrow("boom");
  });
});

describe("in-memory filter (R17) matches the SQL filter", () => {
  // Two customers, both sources, from 2026-01 to 2026-10; "late" has revenue only in 2026-10.
  const HISTORY: ViewRow[] = [
    ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"].flatMap((m, i) => [
      row(m, "erpnext", "acme", 100 + i, 1, "Acme Foods Inc."),
      row(m, "legacy_unit_b", "acme", `${20 + i}.05`, 2, "Acme Foods Inc."),
      row(m, "legacy_unit_b", "unmapped:legacy_unit_b:Old Mill", 30 - i, 1, "Old Mill", false),
    ]),
    row("2026-10", "erpnext", "late", 500, 3, "Late Starter"),
    row("2026-04", "erpnext", "acme", -15.5, 1, "Acme Foods Inc."),
  ].sort((a, b) => a.month.localeCompare(b.month));

  // What PostgREST returned before R17: month (a date) >= from-01 and <= to-01, eq source, eq customer_key.
  function sqlFilter(rows: ViewRow[], filters: CustomerRevenueFilters): ViewRow[] {
    return rows.filter(
      (r) =>
        r.month >= `${filters.range.from}-01` &&
        r.month <= `${filters.range.to}-01` &&
        (!filters.source || r.source === filters.source) &&
        (!filters.customer || r.customer_key === filters.customer),
    );
  }

  // The pre-R17 service output, built from the SQL-filtered rows plus the whole history.
  function beforeR17(filters: CustomerRevenueFilters, asOfDate: string) {
    const months = monthsBetween(filters.range);
    const histories = historyByCustomer(HISTORY);
    const customers = aggregateByCustomer(sqlFilter(HISTORY, filters), months).map((c) => ({ ...c, trend: trend(histories.get(c.key) ?? new Map(), asOfDate) }));
    return { customers, customerOptions: customerOptions(HISTORY) };
  }

  const CASES: CustomerRevenueFilters[] = [
    { range: { from: "2026-01", to: "2026-10" }, source: null, customer: null },
    { range: { from: "2026-04", to: "2026-06" }, source: null, customer: null },
    { range: { from: "2026-04", to: "2026-04" }, source: "erpnext", customer: null },
    { range: { from: "2026-02", to: "2026-09" }, source: "legacy_unit_b", customer: "acme" },
    { range: { from: "2026-01", to: "2026-10" }, source: null, customer: "unmapped:legacy_unit_b:Old Mill" },
    { range: { from: "2025-11", to: "2026-01" }, source: null, customer: null },
    { range: { from: "2026-11", to: "2026-12" }, source: null, customer: null },
    { range: { from: "2026-01", to: "2026-10" }, source: null, customer: "nobody" },
  ];

  it.each(CASES.map((filters) => [JSON.stringify(filters), filters] as const))("gives the same rows, totals, options and trends for %s", async (_name, filters) => {
    const { client } = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: HISTORY, error: null, count: HISTORY.length } });
    const result = await createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue(filters);
    const expected = beforeR17(filters, result.asOf.date);
    expect(filterRows(HISTORY, filters)).toEqual(sqlFilter(HISTORY, filters));
    expect(result.customers).toEqual(expected.customers);
    expect(result.customerOptions).toEqual(expected.customerOptions);
    const totalCents = expected.customers.reduce((sum, c) => sum + c.total.revenueCents, 0);
    expect(result.total.revenueCents).toBe(totalCents);
    expect(result.total.invoices).toBe(expected.customers.reduce((sum, c) => sum + c.total.invoices, 0));
    expect(result.months.map((m) => m.revenueCents)).toEqual(
      monthsBetween(filters.range).map((_m, i) => expected.customers.reduce((sum, c) => sum + (c.months[i]?.revenueCents ?? 0), 0)),
    );
  });

  it("leaves out a customer whose revenue is only outside the range, but keeps it in the options", async () => {
    const { client } = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: HISTORY, error: null } });
    const result = await createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({ range: { from: "2026-01", to: "2026-09" }, source: null, customer: null });
    expect(result.customers.map((c) => c.key)).not.toContain("late");
    expect(result.customerOptions.map((o) => o.key)).toContain("late");
  });

  it("keeps the range bounds inclusive and compares source and customer exactly", () => {
    const rows = [row("2026-03", "erpnext", "acme", 1), row("2026-05", "erpnext", "acme", 1), row("2026-06", "erpnext", "acme", 1), row("2026-04", "erpnext", "acme2", 1)];
    expect(filterRows(rows, { range: { from: "2026-03", to: "2026-05" }, source: null, customer: null }).map((r) => r.month)).toEqual([
      "2026-03-01",
      "2026-05-01",
      "2026-04-01",
    ]);
    expect(filterRows(rows, { range: { from: "2026-01", to: "2026-12" }, source: "legacy_unit_b", customer: null })).toEqual([]);
    expect(filterRows(rows, { range: { from: "2026-01", to: "2026-12" }, source: null, customer: "acme" })).toHaveLength(3);
  });
});

describe("trend per customer (T20)", () => {
  it("adds every source into one history per customer key", () => {
    const history = historyByCustomer([row("2026-04", "erpnext", "acme", 10), row("2026-04", "legacy_unit_b", "acme", "0.50")]);
    expect([...(history.get("acme") ?? [])]).toEqual([["2026-04", 1050]]);
  });

  it("uses the whole history and both sources, whatever the filters", async () => {
    // Filtered to ERPNext in September only; the history (every row) says Unit B grew from Apr–Jun to Jul–Sep.
    const history = [
      ...["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((m) => row(m, "erpnext", "acme", 100)),
      ...["2026-07", "2026-08", "2026-09"].map((m) => row(m, "legacy_unit_b", "acme", 100)),
    ];
    const { client } = fakeSupabase({ ...SOURCES, customer_monthly_revenue: { data: history, error: null } });
    const result = await createCustomerRevenueService(client, { now: NOW }).getCustomerRevenue({
      range: { from: "2026-09", to: "2026-09" },
      source: "erpnext",
      customer: null,
    });
    expect(result.customers[0]?.total.revenue).toBe("100.00");
    expect(result.customers[0]?.trend).toMatchObject({ label: "growing", rule: 4, prev3Cents: 30000, last3Cents: 60000, lastCompleteMonth: "2026-09" });
  });
});
