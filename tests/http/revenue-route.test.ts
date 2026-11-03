import { describe, expect, it, jest } from "@jest/globals";
import * as route from "../../app/api/revenue/monthly/route.ts";
import { createRevenueMonthlyHandler } from "../../src/http/revenue-handler.ts";
import { createRevenueService } from "../../src/services/revenue-service.ts";
import { fakeSupabase, issuedNames } from "./fake-supabase.ts";

// T10: GET /api/revenue/monthly — handler + revenueService over a fake database client.
const URL_BASE = "http://localhost:3000/api/revenue/monthly";

function handlerWith(result: { data: unknown; error: { message: string } | null }, deferred = false) {
  const fake = fakeSupabase(
    {
      monthly_revenue: result,
      sync_run: { data: [{ finished_at: "2026-10-18T18:00:00+00:00" }], error: null },
      source_file: { data: null, error: { message: "relation \"public.source_file\" does not exist", code: "42P01" } },
    },
    {},
    { deferred },
  );
  const now = () => new Date("2026-10-18T20:00:00Z");
  return { GET: createRevenueMonthlyHandler(() => createRevenueService(fake.client, { now })), calls: fake.calls, fake };
}

describe("GET /api/revenue/monthly", () => {
  it("returns January to October 2026 by default, as JSON", async () => {
    const { GET } = handlerWith({
      data: [{ month: "2026-03-01", source: "erpnext", revenue: 1234.5, invoices: 3 }],
      error: null,
    });

    const response = await GET(new Request(URL_BASE));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as { months: { month: string; revenue: string }[]; total: unknown };
    expect(body.months.map((month) => month.month)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
      "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
    ]);
    expect(body.months[2]).toEqual({
      month: "2026-03",
      revenueCents: 123450,
      revenue: "1234.50",
      invoices: 3,
      bySource: {
        erpnext: { revenueCents: 123450, revenue: "1234.50", invoices: 3 },
        legacy_unit_b: { revenueCents: 0, revenue: "0.00", invoices: 0 },
      },
      complete: true,
    });
    expect(body.months[9]).toMatchObject({ month: "2026-10", complete: false });
    expect((body as unknown as { asOf: unknown }).asOf).toEqual({ date: "2026-10-18", basis: "erpnext" });
    expect(body.total).toEqual({
      revenueCents: 123450,
      revenue: "1234.50",
      invoices: 3,
      bySource: {
        erpnext: { revenueCents: 123450, revenue: "1234.50", invoices: 3 },
        legacy_unit_b: { revenueCents: 0, revenue: "0.00", invoices: 0 },
      },
    });
  });

  it("returns the period total by source for the reconciliation's period (R20)", async () => {
    const { GET, calls } = handlerWith({
      data: [
        { month: "2026-03-01", source: "erpnext", revenue: "462664.00", invoices: 150 },
        { month: "2026-04-01", source: "legacy_unit_b", revenue: "109915.83", invoices: 60 },
      ],
      error: null,
    });
    const response = await GET(new Request(`${URL_BASE}?from=2026-01&to=2026-12`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { months: unknown[]; total: unknown };
    expect(body.months).toHaveLength(12);
    expect(calls[0]?.chain).toContainEqual(["lte", "month", "2026-12-01"]);
    expect(body.total).toEqual({
      revenueCents: 57257983,
      revenue: "572579.83",
      invoices: 210,
      bySource: {
        erpnext: { revenueCents: 46266400, revenue: "462664.00", invoices: 150 },
        legacy_unit_b: { revenueCents: 10991583, revenue: "109915.83", invoices: 60 },
      },
    });
  });

  it("returns 500 Problem Details when the view returns a source outside the canonical list (R19)", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = handlerWith({ data: [{ month: "2026-03-01", source: "unit_c", revenue: 10, invoices: 1 }], error: null });
    const response = await GET(new Request(URL_BASE));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(JSON.stringify(await response.json())).not.toContain("unit_c");
    spy.mockRestore();
  });

  it("honours from and to", async () => {
    const { GET, calls } = handlerWith({ data: [], error: null });
    const response = await GET(new Request(`${URL_BASE}?from=2026-02&to=2026-04`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { months: unknown[] };
    expect(body.months).toHaveLength(3);
    expect(calls[0]?.chain).toContainEqual(["gte", "month", "2026-02-01"]);
  });

  it("answers in one round trip to the database", async () => {
    const { GET, fake } = handlerWith({ data: [], error: null }, true);
    const pending = GET(new Request(URL_BASE));
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["monthly_revenue", "source_file", "source_file", "sync_run"]);
    fake.releaseAll();
    expect((await pending).status).toBe(200);
  });

  it.each([
    ["from=2026-13", "'from' must be YYYY-MM"],
    ["to=2026-1", "'to' must be YYYY-MM"],
    ["from=abc", "'from' must be YYYY-MM"],
    ["from=2026-05&to=2026-04", "'from' must not be after 'to'"],
    ["from=2000-01&to=2026-10", "at most 120 months"],
  ])("rejects %s with 400 Problem Details", async (query, detail) => {
    const { GET, calls } = handlerWith({ data: [], error: null });
    const response = await GET(new Request(`${URL_BASE}?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
    expect(body["detail"]).toContain(detail);
    expect(calls).toHaveLength(0);
  });

  it("returns 500 Problem Details when the database fails, without leaking the cause", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = handlerWith({ data: null, error: { message: "connection refused to secret-host" } });
    const response = await GET(new Request(URL_BASE));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "about:blank", title: "Internal Server Error", status: 500 });
    expect(JSON.stringify(body)).not.toContain("secret-host");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405 and Allow: GET", async (method) => {
    const response = await route[method](new Request(URL_BASE, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ title: "Method Not Allowed", status: 405 });
  });
});
