import { describe, expect, it, jest } from "@jest/globals";
import * as route from "../../app/api/freshness/route.ts";
import { createFreshnessHandler } from "../../src/http/freshness-handler.ts";
import { createFreshnessService } from "../../src/services/freshness-service.ts";
import { fakeSupabase, issuedNames, type Result } from "./fake-supabase.ts";

// T10: GET /api/freshness — handler + freshnessService over a fake database client.
const URL = "http://localhost:3000/api/freshness";
const SYNC_RUN: Result = {
  data: [{ finished_at: "2026-10-18T18:00:00+00:00", status: "succeeded", started_at: "2026-10-18T17:59:00+00:00", error: null }],
  error: null,
};
const MISSING = (name: string): Result => ({ data: null, error: { message: `relation "public.${name}" does not exist`, code: "42P01" } });

function handlerWith(syncRun: Result, options: { testSwitchesEnabled: boolean; switchOn?: boolean }, fakeOptions: { deferred?: boolean } = {}) {
  const fake = fakeSupabase(
    {
      sync_run: syncRun,
      source_file: MISSING("source_file"),
      reconciliation_run: MISSING("reconciliation_run"),
      consumer_heartbeat: { data: [{ last_run_at: "2026-10-18T19:59:00Z", processed: 1, parked: 0, oldest_message_age: null }], error: null },
      dead_letter: { data: null, error: null, count: 0 },
      monthly_revenue: { data: [{ month: "2026-03-01", source: "erpnext", revenue: "1234.50" }], error: null },
    },
    {
      app_test_switch: { data: options.switchOn ?? false, error: null },
      app_queue_metrics: { data: [{ queue_name: "invoice_events", queue_length: 0, oldest_msg_age_sec: null }], error: null },
    },
    fakeOptions,
  );
  const now = () => new Date("2026-10-18T20:00:00Z");
  return Object.assign(createFreshnessHandler(() => createFreshnessService(fake.client, { ...options, now })), { fake });
}

describe("GET /api/freshness", () => {
  it("returns the last successful ERPNext sync and the health readings", async () => {
    const GET = handlerWith(SYNC_RUN, { testSwitchesEnabled: false });
    const response = await GET(new Request(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      asOf: { date: "2026-10-18", basis: "erpnext" },
      erpnext: { lastSuccessfulSync: "2026-10-18T18:00:00+00:00", lastRun: { status: "succeeded" } },
      legacyUnitB: { available: false },
      // R20: the period and the comparison come back even before the reconciliation table exists.
      reconciliation: {
        available: false,
        period: { from: "2026-01-01", to: "2026-12-31" },
        latest: null,
        lastSucceeded: null,
        erpnextValidCents: 123450,
        comparison: { result: "no-successful-run", erpnextValidCents: 123450 },
      },
      queue: { available: true, pending: 0 },
      deadLetter: { count: 0 },
      alerts: [],
    });
  });

  it("returns 500 Problem Details when the fail_freshness_api switch is on (demo scene b)", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const GET = handlerWith(SYNC_RUN, { testSwitchesEnabled: true, switchOn: true });
    const response = await GET(new Request(URL));
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "Injected failure: test switch fail_freshness_api is on",
    });
    spy.mockRestore();
  });

  it("answers in one round trip to the database, the test switch included", async () => {
    const GET = handlerWith(SYNC_RUN, { testSwitchesEnabled: true }, { deferred: true });
    const pending = GET(new Request(URL));
    await GET.fake.settle();
    expect(issuedNames(GET.fake)).toEqual(
      [
        "consumer_heartbeat",
        "dead_letter",
        "monthly_revenue",
        "reconciliation_run",
        "reconciliation_run",
        "rpc:app_queue_metrics",
        "rpc:app_test_switch",
        "source_file",
        "source_file",
        "sync_run",
        "sync_run",
      ],
    );
    GET.fake.releaseAll();
    expect((await pending).status).toBe(200);
  });

  it("ignores the switch when ENABLE_TEST_SWITCHES is off", async () => {
    const GET = handlerWith(SYNC_RUN, { testSwitchesEnabled: false, switchOn: true });
    expect((await GET(new Request(URL))).status).toBe(200);
  });

  it("returns 500 Problem Details when the database fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const GET = handlerWith({ data: null, error: { message: "down" } }, { testSwitchesEnabled: false });
    const response = await GET(new Request(URL));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      status: 500,
      detail: "Unexpected error while reading freshness.",
    });
    spy.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405 and Allow: GET", async (method) => {
    const response = await route[method](new Request(URL, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});
