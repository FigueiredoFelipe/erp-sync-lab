import { describe, expect, it, jest } from "@jest/globals";
import * as route from "../../app/api/revenue/customers/route.ts";
import { createCustomerRevenueHandler } from "../../src/http/customer-revenue-handler.ts";
import { createCustomerRevenueService } from "../../src/services/customer-revenue-service.ts";
import { fakeSupabase, issuedNames, type Result } from "./fake-supabase.ts";

// T17: GET /api/revenue/customers — handler + customerRevenueService over a fake database client.
const URL_BASE = "http://localhost:3000/api/revenue/customers";

const VIEW_ROWS = [
  { month: "2026-03-01", source: "erpnext", customer_key: "acme", customer_name: "Acme Foods Inc.", mapped: true, revenue: 1000.1, invoices: 1 },
  { month: "2026-03-01", source: "legacy_unit_b", customer_key: "acme", customer_name: "Acme Foods Inc.", mapped: true, revenue: "200.05", invoices: 1 },
  { month: "2026-04-01", source: "erpnext", customer_key: "unmapped:erpnext:Mystery", customer_name: "Mystery", mapped: false, revenue: 5, invoices: 1 },
];

function handlerWith(view: Result, deferred = false) {
  const fake = fakeSupabase(
    {
      customer_monthly_revenue: view,
      sync_run: { data: [{ finished_at: "2026-10-18T18:00:00Z" }], error: null },
      source_file: { data: null, error: { message: "relation \"public.source_file\" does not exist", code: "42P01" } },
    },
    {},
    { deferred },
  );
  const now = () => new Date("2026-10-18T20:00:00Z");
  return { GET: createCustomerRevenueHandler(() => createCustomerRevenueService(fake.client, { now })), calls: fake.calls, fake };
}

describe("GET /api/revenue/customers", () => {
  it("returns per-customer monthly totals, both sources combined, January to October 2026 by default", async () => {
    const { GET } = handlerWith({ data: VIEW_ROWS, error: null });
    const response = await GET(new Request(URL_BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      from: string;
      to: string;
      customers: { key: string; name: string; mapped: boolean; months: { month: string; revenue: string }[]; total: unknown }[];
      total: unknown;
    };
    expect([body.from, body.to]).toEqual(["2026-01", "2026-10"]);
    expect(body.customers.map((c) => [c.key, c.mapped])).toEqual([
      ["acme", true],
      ["unmapped:erpnext:Mystery", false],
    ]);
    expect(body.customers[0]?.months.find((m) => m.month === "2026-03")?.revenue).toBe("1200.15");
    expect(body.customers[0]?.total).toEqual({ revenueCents: 120015, revenue: "1200.15", invoices: 2 });
    expect(body.total).toEqual({ revenueCents: 120515, revenue: "1205.15", invoices: 3 });
  });

  it("applies source, customer and range filters", async () => {
    const { GET, calls } = handlerWith({ data: VIEW_ROWS, error: null });
    const response = await GET(new Request(`${URL_BASE}?source=legacy_unit_b&customer=acme&from=2026-03&to=2026-06`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { customers: { key: string }[]; customerOptions: { key: string }[]; total: unknown };
    expect(body.customers.map((c) => c.key)).toEqual(["acme"]);
    expect(body.total).toEqual({ revenueCents: 20005, revenue: "200.05", invoices: 1 });
    // The filter options still list every customer.
    expect(body.customerOptions.map((o) => o.key)).toEqual(["acme", "unmapped:erpnext:Mystery"]);
    // One read of the whole history; the filters are applied in memory (R17).
    expect(calls.filter((c) => c.table === "customer_monthly_revenue").map((c) => c.chain)).toEqual([
      [
        ["select", "month, source, customer_key, customer_name, mapped, revenue, invoices", { count: "exact" }],
        ["order", "month"],
      ],
    ]);
  });

  it("answers in one round trip to the database", async () => {
    const { GET, fake } = handlerWith({ data: VIEW_ROWS, error: null }, true);
    const pending = GET(new Request(`${URL_BASE}?source=erpnext`));
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["customer_monthly_revenue", "source_file", "source_file", "sync_run"]);
    fake.releaseAll();
    expect((await pending).status).toBe(200);
  });

  it.each([
    ["source=sap", "'source' must be one of"],
    ["from=2026-13", "'from' must be YYYY-MM"],
    ["from=2026-06&to=2026-04", "'from' must not be after 'to'"],
    [`customer=${"x".repeat(201)}`, "at most 200 printable characters"],
    ["customer=a%0Ab", "printable characters"],
    ["cusomter=acme", "Unknown query parameter 'cusomter'"],
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
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Internal Server Error", status: 500, detail: "Unexpected error while reading customer revenue." });
    expect(JSON.stringify(body)).not.toContain("secret-host");
    spy.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405 and Allow: GET", async (method) => {
    const response = await route[method](new Request(URL_BASE, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});
