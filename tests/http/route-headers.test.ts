import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { Opened } from "../../src/http/access.ts";

// T26 / PLAN R17 point 4: every data response, success or Problem Details, carries Cache-Control: no-store,
// and only an allowed caller gets Server-Timing. openSession() and the services are mocked.
const openSession = jest.fn<() => Promise<Opened<unknown>>>();
jest.mock("../../app/_lib/supabase.ts", () => ({ openSession: () => openSession() }));

const serviceCall = jest.fn<() => Promise<unknown>>();
const service = {
  getMonthlyRevenue: () => serviceCall(),
  getCustomerRevenue: () => serviceCall(),
  getDocuments: () => serviceCall(),
  listOpen: () => serviceCall(),
  getFreshness: () => serviceCall(),
};
jest.mock("../../app/_lib/services.ts", () => ({
  revenueService: () => () => service,
  customerRevenueService: () => () => service,
  documentsService: () => () => service,
  quarantineService: () => () => service,
  freshnessService: () => () => service,
}));

// [path, a valid query, a query the handler answers 400 to (null: the route takes no parameters)]
const ROUTES = [
  ["/api/revenue/monthly", "?from=2026-01&to=2026-10", "?from=2026-13", () => import("../../app/api/revenue/monthly/route.ts")],
  ["/api/revenue/customers", "?source=erpnext", "?source=sap", () => import("../../app/api/revenue/customers/route.ts")],
  ["/api/revenue/documents", "?customer=ACME&month=2026-03", "?month=2026-03", () => import("../../app/api/revenue/documents/route.ts")],
  ["/api/quarantine", "", "?reason=nope", () => import("../../app/api/quarantine/route.ts")],
  ["/api/freshness", "", null, () => import("../../app/api/freshness/route.ts")],
] as const;

const opened = (user: unknown, allowed: unknown): Opened<unknown> => ({
  status: "open",
  session: {
    getUser: async () => ({ data: { user }, error: null }),
    isAllowlisted: async () => ({ data: allowed, error: null }),
    client: {},
  },
});

beforeEach(() => {
  openSession.mockReset();
  serviceCall.mockReset();
  serviceCall.mockResolvedValue({ rows: [] });
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe.each(ROUTES)("%s", (path, valid, invalid, load) => {
  const call = async (query: string, method = "GET") => {
    const route = (await load()) as unknown as Record<string, (request: Request) => Response | Promise<Response>>;
    return route[method]!(new Request(`http://localhost:3000${path}${query}`, { method }));
  };
  const timing = /^app;dur=\d+\.\d$/;

  it("200: no-store and Server-Timing", async () => {
    openSession.mockResolvedValue(opened({ id: "u1" }, true));
    const response = await call(valid);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toMatch(timing);
  });

  if (invalid !== null) {
    it("400 from the handler: no-store and Server-Timing", async () => {
      openSession.mockResolvedValue(opened({ id: "u1" }, true));
      const response = await call(invalid);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("server-timing")).toMatch(timing);
    });
  }

  it("401: no-store, no Server-Timing", async () => {
    openSession.mockResolvedValue({ status: "signed-out" });
    const response = await call(valid);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toBeNull();
  });

  it("403: no-store, no Server-Timing, no data", async () => {
    openSession.mockResolvedValue(opened({ id: "u1" }, false));
    serviceCall.mockResolvedValue({ secret: "must not leak" });
    const response = await call(valid);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toBeNull();
    expect(await response.text()).not.toContain("must not leak");
  });

  it("405: no-store", async () => {
    const response = await call(valid, "POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(openSession).not.toHaveBeenCalled();
  });

  it("500 from the handler: no-store and Server-Timing", async () => {
    openSession.mockResolvedValue(opened({ id: "u1" }, true));
    serviceCall.mockRejectedValue(new Error("database down"));
    const response = await call(valid);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toMatch(timing);
  });

  it("500 opening the session: no-store, no Server-Timing", async () => {
    openSession.mockRejectedValue(new Error("getClaims failed: down"));
    const response = await call(valid);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toBeNull();
  });
});
