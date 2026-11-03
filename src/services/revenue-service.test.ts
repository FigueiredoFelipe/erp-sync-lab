import { describe, expect, it } from "@jest/globals";
import { fakeSupabase, issuedNames, type Result } from "../../tests/http/fake-supabase.ts";
import { createRevenueService, monthsBetween } from "./revenue-service.ts";

describe("monthsBetween", () => {
  it("lists every month inclusive, across years", () => {
    expect(monthsBetween({ from: "2026-01", to: "2026-03" })).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(monthsBetween({ from: "2025-11", to: "2026-02" })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
});

// Source dates for the as-of date: last ERPNext sync on Oct 18 (EDT); Source B not merged yet.
const SYNC_RUN: Result = { data: [{ finished_at: "2026-10-18T18:00:00+00:00" }], error: null };
const NO_SOURCE_FILE: Result = { data: null, error: { message: "Could not find the table 'public.source_file' in the schema cache", code: "PGRST205" } };
const SOURCES = { sync_run: SYNC_RUN, source_file: NO_SOURCE_FILE };
const NOW = () => new Date("2026-10-20T12:00:00Z");
const part = (revenueCents: number, revenue: string, invoices: number) => ({ revenueCents, revenue, invoices });
const ZERO = part(0, "0.00", 0);

describe("revenueService.getMonthlyRevenue", () => {
  it("combines sources per month in cents, fills empty months with zero and totals them", async () => {
    const { client, calls } = fakeSupabase({
      ...SOURCES,
      monthly_revenue: {
        data: [
          { month: "2026-01-01", source: "erpnext", revenue: 1000.1, invoices: 2 },
          { month: "2026-01-01", source: "legacy_unit_b", revenue: "0.20", invoices: 1 },
          { month: "2026-03-01", source: "erpnext", revenue: -50.05, invoices: 1 },
        ],
        error: null,
      },
    });

    const result = await createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-03" });

    expect(result.months).toEqual([
      {
        month: "2026-01",
        revenueCents: 100030,
        revenue: "1000.30",
        invoices: 3,
        bySource: { erpnext: part(100010, "1000.10", 2), legacy_unit_b: part(20, "0.20", 1) },
        complete: true,
      },
      { month: "2026-02", revenueCents: 0, revenue: "0.00", invoices: 0, bySource: { erpnext: ZERO, legacy_unit_b: ZERO }, complete: true },
      {
        month: "2026-03",
        revenueCents: -5005,
        revenue: "-50.05",
        invoices: 1,
        bySource: { erpnext: part(-5005, "-50.05", 1), legacy_unit_b: ZERO },
        complete: true,
      },
    ]);
    expect(result.total).toEqual({
      revenueCents: 95025,
      revenue: "950.25",
      invoices: 4,
      bySource: { erpnext: part(95005, "950.05", 3), legacy_unit_b: part(20, "0.20", 1) },
    });
    expect(result.currency).toBe("USD");
    expect(calls[0]?.table).toBe("monthly_revenue");
    expect(calls[0]?.chain).toContainEqual(["gte", "month", "2026-01-01"]);
    expect(calls[0]?.chain).toContainEqual(["lte", "month", "2026-03-01"]);
  });

  it("returns zeros for every month when there are no invoices", async () => {
    const { client } = fakeSupabase({ ...SOURCES, monthly_revenue: { data: [], error: null } });
    const result = await createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-10" });
    expect(result.months).toHaveLength(10);
    expect(result.total).toEqual({ revenueCents: 0, revenue: "0.00", invoices: 0, bySource: { erpnext: ZERO, legacy_unit_b: ZERO } });
  });

  it("throws when the query fails", async () => {
    const { client } = fakeSupabase({ ...SOURCES, monthly_revenue: { data: null, error: { message: "boom" } } });
    await expect(createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-10" })).rejects.toThrow(
      "boom",
    );
  });
});

describe("revenueService by source (R19)", () => {
  async function monthsFrom(rows: unknown[]) {
    const { client } = fakeSupabase({ ...SOURCES, monthly_revenue: { data: rows, error: null } });
    return createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-04" });
  }

  it("splits every month by source, and the parts add up to the month's total to the cent", async () => {
    const result = await monthsFrom([
      // Both sources positive.
      { month: "2026-01-01", source: "erpnext", revenue: "1200.33", invoices: 4 },
      { month: "2026-01-01", source: "legacy_unit_b", revenue: 300.01, invoices: 2 },
      // One source negative (credit notes, BR07), the other positive.
      { month: "2026-02-01", source: "erpnext", revenue: 500, invoices: 3 },
      { month: "2026-02-01", source: "legacy_unit_b", revenue: "-120.45", invoices: 1 },
      // One source absent.
      { month: "2026-03-01", source: "legacy_unit_b", revenue: 99.99, invoices: 1 },
    ]);

    expect(result.months.map((m) => [m.month, m.bySource])).toEqual([
      ["2026-01", { erpnext: part(120033, "1200.33", 4), legacy_unit_b: part(30001, "300.01", 2) }],
      ["2026-02", { erpnext: part(50000, "500.00", 3), legacy_unit_b: part(-12045, "-120.45", 1) }],
      ["2026-03", { erpnext: ZERO, legacy_unit_b: part(9999, "99.99", 1) }],
      ["2026-04", { erpnext: ZERO, legacy_unit_b: ZERO }],
    ]);
    for (const month of result.months) {
      expect(month.bySource.erpnext.revenueCents + month.bySource.legacy_unit_b.revenueCents).toBe(month.revenueCents);
      expect(month.bySource.erpnext.invoices + month.bySource.legacy_unit_b.invoices).toBe(month.invoices);
    }
    expect(result.months[1]).toMatchObject({ revenueCents: 37955, revenue: "379.55", invoices: 4 });
    // R20: the period total is split by source too, and its parts add up to it to the cent.
    expect(result.total).toEqual({
      revenueCents: 197988,
      revenue: "1979.88",
      invoices: 11,
      bySource: { erpnext: part(170033, "1700.33", 7), legacy_unit_b: part(27955, "279.55", 4) },
    });
    expect(result.total.bySource.erpnext.revenueCents + result.total.bySource.legacy_unit_b.revenueCents).toBe(result.total.revenueCents);
  });

  it("throws on a source outside the canonical list (fail-closed: the segments would not add up)", async () => {
    await expect(monthsFrom([{ month: "2026-01-01", source: "unit_c", revenue: 1, invoices: 1 }])).rejects.toThrow(
      "unknown source: unit_c",
    );
  });

  it("throws on an unknown source even in a row outside the range", async () => {
    await expect(monthsFrom([{ month: "2025-12-01", source: "unit_c", revenue: 1, invoices: 1 }])).rejects.toThrow(
      "unknown source: unit_c",
    );
  });
});

describe("revenueService period total by source (R20)", () => {
  it("keeps a source with no invoices in the period as $0.00 with 0 invoices, not missing", async () => {
    const { client } = fakeSupabase({
      ...SOURCES,
      monthly_revenue: { data: [{ month: "2026-02-01", source: "erpnext", revenue: "10.00", invoices: 1 }], error: null },
    });
    const result = await createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-03" });
    expect(result.total.bySource).toEqual({ erpnext: part(1000, "10.00", 1), legacy_unit_b: ZERO });
  });

  it("reads only the invoice view: an open quarantine row can't change any figure", async () => {
    const { client, calls } = fakeSupabase({
      ...SOURCES,
      monthly_revenue: { data: [{ month: "2026-02-01", source: "legacy_unit_b", revenue: "5.00", invoices: 1 }], error: null },
      quarantine: { data: [{ source: "legacy_unit_b", source_doc_id: "B-1", status: "open" }], error: null },
    });
    const result = await createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-03" });
    expect(calls.map((c) => c.table)).not.toContain("quarantine");
    expect(result.total.bySource.legacy_unit_b).toEqual(part(500, "5.00", 1));
  });
});

describe("revenueService round trips (R17)", () => {
  it("reads the view and the as-of dates in one round trip", async () => {
    const fake = fakeSupabase({ ...SOURCES, monthly_revenue: { data: [], error: null } }, {}, { deferred: true });
    const promise = createRevenueService(fake.client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-03" });
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["monthly_revenue", "source_file", "source_file", "sync_run"]);
    fake.releaseAll();
    expect((await promise).asOf).toEqual({ date: "2026-10-18", basis: "erpnext" });
  });

  it("waits for the as-of reads before failing on the view", async () => {
    const fake = fakeSupabase({ ...SOURCES, monthly_revenue: { data: null, error: { message: "boom" } } }, {}, { deferred: true });
    let settled = false;
    const promise = createRevenueService(fake.client, { now: NOW })
      .getMonthlyRevenue({ from: "2026-01", to: "2026-03" })
      .finally(() => {
        settled = true;
      });
    await fake.settle();
    fake.release("monthly_revenue");
    await fake.settle();
    expect(settled).toBe(false);
    fake.releaseAll();
    await expect(promise).rejects.toThrow("monthly_revenue query failed: boom");
  });

  it("throws when the as-of dates fail", async () => {
    const { client } = fakeSupabase({ ...SOURCES, sync_run: { data: null, error: { message: "down" } }, monthly_revenue: { data: [], error: null } });
    await expect(createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-01", to: "2026-03" })).rejects.toThrow(
      "sync_run query failed",
    );
  });
});

describe("revenueService partial month (T10c)", () => {
  async function monthsWith(tables: Record<string, Result>) {
    const { client } = fakeSupabase({ monthly_revenue: { data: [], error: null }, ...tables });
    return createRevenueService(client, { now: NOW }).getMonthlyRevenue({ from: "2026-08", to: "2026-11" });
  }

  it("marks the month of the as-of date, and later months, as not complete", async () => {
    const result = await monthsWith(SOURCES);
    expect(result.asOf).toEqual({ date: "2026-10-18", basis: "erpnext" });
    expect(result.months.map((m) => [m.month, m.complete])).toEqual([
      ["2026-08", true],
      ["2026-09", true],
      ["2026-10", false],
      ["2026-11", false],
    ]);
  });

  it("uses the earlier of the ERPNext sync and the newest Source B export", async () => {
    const result = await monthsWith({
      sync_run: { data: [{ finished_at: "2026-11-02T15:00:00Z" }], error: null },
      source_file: { data: [{ exported_at: "2026-10-31", ingested_at: "2026-11-01T10:00:00Z" }], error: null },
    });
    // Oct 31 is the last day of October, which is not before the as-of date: October is still partial.
    expect(result.asOf).toEqual({ date: "2026-10-31", basis: "both" });
    expect(result.months.find((m) => m.month === "2026-10")?.complete).toBe(false);
  });

  it("falls back to today when no source has synced", async () => {
    const result = await monthsWith({ sync_run: { data: [], error: null }, source_file: { data: [], error: null } });
    expect(result.asOf).toEqual({ date: "2026-10-20", basis: "today" });
  });

  it("throws when source_file fails for a reason other than not existing", async () => {
    await expect(monthsWith({ sync_run: SYNC_RUN, source_file: { data: null, error: { message: "timeout" } } })).rejects.toThrow(
      "source_file query failed",
    );
  });
});
