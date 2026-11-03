import { describe, expect, it } from "@jest/globals";
import { fakeSupabase, issuedNames, type Result, type Results } from "../../tests/http/fake-supabase.ts";
import { createFreshnessService, InjectedFailureError } from "./freshness-service.ts";

const NOW = () => new Date("2026-10-18T20:00:00Z");
const SYNC_RUN: Result = {
  data: [{ finished_at: "2026-10-18T18:00:00+00:00", status: "succeeded", started_at: "2026-10-18T17:59:50+00:00", error: null }],
  error: null,
};
const MISSING_TABLE = (name: string): Result => ({
  data: null,
  error: { message: `Could not find the table 'public.${name}' in the schema cache`, code: "PGRST205" },
});

// Everything healthy; source_file and reconciliation_run exist.
const HEALTHY_TABLES: Record<string, Result> = {
  sync_run: SYNC_RUN,
  source_file: { data: [{ exported_at: "2026-10-17", ingested_at: "2026-10-18T12:00:00Z" }], error: null },
  consumer_heartbeat: { data: [{ last_run_at: "2026-10-18T19:59:30Z", processed: 3, parked: 0, oldest_message_age: "00:00:05" }], error: null },
  dead_letter: { data: null, error: null, count: 0 },
  reconciliation_run: {
    data: [{ id: "r1", started_at: "2026-10-18T06:00:00Z", finished_at: "2026-10-18T06:00:09Z", status: "succeeded", erp_total: "461664.00", stored_total: 461664, unexplained: 0, error: null }],
    error: null,
  },
};
// ERPNext valid revenue for 2026: $461,664.00, equal to the run's stored total.
const MONTHLY_REVENUE: Result = {
  data: [
    { month: "2026-01-01", source: "erpnext", revenue: "400000.00" },
    { month: "2026-10-01", source: "erpnext", revenue: 61664 },
  ],
  error: null,
};
HEALTHY_TABLES["monthly_revenue"] = MONTHLY_REVENUE;
const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const RUN_R1 = {
  id: "r1",
  startedAt: "2026-10-18T06:00:00Z",
  finishedAt: "2026-10-18T06:00:09Z",
  status: "succeeded",
  erpTotal: "461664.00",
  storedTotal: "461664",
  unexplained: 0,
  error: null,
};

const HEALTHY_RPCS: Record<string, Result> = {
  app_queue_metrics: {
    data: [
      { queue_name: "invoice_events", queue_length: 2, oldest_msg_age_sec: 40 },
      { queue_name: "invoice_events_dlq", queue_length: "0", oldest_msg_age_sec: null },
    ],
    error: null,
  },
  app_test_switch: { data: false, error: null },
};

function service(tables: Record<string, Results> = {}, rpcs: Record<string, Result> = {}, testSwitchesEnabled = false) {
  const fake = fakeSupabase({ ...HEALTHY_TABLES, ...tables }, { ...HEALTHY_RPCS, ...rpcs });
  return { svc: createFreshnessService(fake.client, { testSwitchesEnabled, now: NOW }), calls: fake.calls };
}

describe("freshnessService.getFreshness", () => {
  it("reports every source, the consumer, the queue, the DLQ and the latest reconciliation", async () => {
    const result = await service().svc.getFreshness();
    expect(result).toEqual({
      checkedAt: "2026-10-18T20:00:00.000Z",
      asOf: { date: "2026-10-17", basis: "both" },
      erpnext: {
        lastSuccessfulSync: "2026-10-18T18:00:00+00:00",
        lastRun: { status: "succeeded", startedAt: "2026-10-18T17:59:50+00:00", finishedAt: "2026-10-18T18:00:00+00:00", error: null },
      },
      legacyUnitB: { available: true, newestExportDate: "2026-10-17", lastSuccessfulIngest: "2026-10-18T12:00:00Z" },
      consumer: { lastRunAt: "2026-10-18T19:59:30Z", processed: 3, parked: 0, oldestMessageAge: "00:00:05" },
      queue: { available: true, pending: 2, oldestPendingAgeSeconds: 40, deadLetterQueueLength: 0 },
      deadLetter: { count: 0 },
      reconciliation: {
        available: true,
        period: YEAR,
        latest: RUN_R1,
        lastSucceeded: RUN_R1,
        erpnextValidCents: 46166400,
        comparison: { result: "matches", erpnextValidCents: 46166400, storedTotalCents: 46166400, runStartedAt: "2026-10-18T06:00:00Z" },
      },
      alerts: [],
    });
  });

  it("queries the newest successful ERPNext run for the last successful sync", async () => {
    const { svc, calls } = service();
    await svc.getFreshness();
    expect(calls.find((c) => c.table === "sync_run")?.chain).toEqual([
      ["select", "finished_at"],
      ["eq", "source", "erpnext"],
      ["eq", "status", "succeeded"],
      ["order", "finished_at", { ascending: false }],
      ["limit", 1],
    ]);
  });

  it("degrades to 'not available' while source_file, reconciliation_run and the metrics wrapper don't exist", async () => {
    const result = await service(
      { source_file: MISSING_TABLE("source_file"), reconciliation_run: MISSING_TABLE("reconciliation_run") },
      { app_queue_metrics: { data: null, error: { message: "Could not find the function public.app_queue_metrics", code: "PGRST202" } } },
    ).svc.getFreshness();
    expect(result.legacyUnitB).toEqual({ available: false, newestExportDate: null, lastSuccessfulIngest: null });
    expect(result.reconciliation).toEqual({
      available: false,
      period: YEAR,
      latest: null,
      lastSucceeded: null,
      erpnextValidCents: 46166400,
      comparison: { result: "no-successful-run", erpnextValidCents: 46166400 },
    });
    expect(result.queue).toEqual({ available: false, pending: null, oldestPendingAgeSeconds: null, deadLetterQueueLength: null });
    expect(result.asOf).toEqual({ date: "2026-10-18", basis: "erpnext" });
    expect(result.alerts).toEqual([]);
  });

  it("raises the red-banner alerts from the readings", async () => {
    const result = await service(
      {
        consumer_heartbeat: { data: [{ last_run_at: "2026-10-18T19:50:00Z", processed: 0, parked: 1, oldest_message_age: null }], error: null },
        reconciliation_run: {
          data: [{ id: "r2", started_at: "2026-10-18T06:00:00Z", finished_at: null, status: "succeeded", erp_total: null, stored_total: null, unexplained: 2, error: null }],
          error: null,
        },
      },
      {
        app_queue_metrics: {
          data: [
            { queue_name: "invoice_events", queue_length: 5, oldest_msg_age_sec: 900 },
            { queue_name: "invoice_events_dlq", queue_length: 1, oldest_msg_age_sec: 10 },
          ],
          error: null,
        },
      },
    ).svc.getFreshness();
    expect(result.alerts.map((a) => a.code)).toEqual([
      "CONSUMER_STALE",
      "QUEUE_BACKLOG",
      "DEAD_LETTERS",
      "PARKED_MESSAGES",
      "RECONCILIATION_UNEXPLAINED",
    ]);
  });

  it("falls back to the dead_letter ledger for the DLQ alert when the metrics wrapper is missing", async () => {
    const result = await service(
      { dead_letter: { data: null, error: null, count: 3 } },
      { app_queue_metrics: { data: null, error: { message: "function public.app_queue_metrics() does not exist", code: "42883" } } },
    ).svc.getFreshness();
    expect(result.deadLetter.count).toBe(3);
    expect(result.alerts.map((a) => a.code)).toEqual(["DEAD_LETTERS"]);
  });

  it("returns null dates when nothing has synced yet", async () => {
    const result = await service({ sync_run: { data: [], error: null }, source_file: { data: [], error: null } }).svc.getFreshness();
    expect(result.erpnext).toEqual({ lastSuccessfulSync: null, lastRun: null });
    expect(result.legacyUnitB).toEqual({ available: true, newestExportDate: null, lastSuccessfulIngest: null });
    expect(result.asOf).toEqual({ date: "2026-10-18", basis: "today" });
  });

  it("never reads the test switch when switches are disabled", async () => {
    const { svc, calls } = service({}, { app_test_switch: { data: true, error: null } });
    await svc.getFreshness();
    expect(calls.some((call) => call.rpc === "app_test_switch")).toBe(false);
  });

  it("fails on purpose when switches are enabled and fail_freshness_api is on", async () => {
    const { svc, calls } = service({}, { app_test_switch: { data: true, error: null } }, true);
    await expect(svc.getFreshness()).rejects.toBeInstanceOf(InjectedFailureError);
    expect(calls[0]).toMatchObject({ rpc: "app_test_switch", args: { p_name: "fail_freshness_api" } });
  });

  it("works normally when switches are enabled but the switch is off", async () => {
    const result = await service({}, {}, true).svc.getFreshness();
    expect(result.erpnext.lastSuccessfulSync).toBe("2026-10-18T18:00:00+00:00");
  });

  it.each([
    ["sync_run", { sync_run: { data: null, error: { message: "down" } } }, {}],
    ["consumer_heartbeat", { consumer_heartbeat: { data: null, error: { message: "down" } } }, {}],
    ["dead_letter", { dead_letter: { data: null, error: { message: "down" } } }, {}],
    ["reconciliation_run (other than missing)", { reconciliation_run: { data: null, error: { message: "timeout" } } }, {}],
    ["app_queue_metrics (other than missing)", {}, { app_queue_metrics: { data: null, error: { message: "timeout" } } }],
  ] as [string, Record<string, Result>, Record<string, Result>][])("throws when %s fails", async (_name, tables, rpcs) => {
    await expect(service(tables, rpcs).svc.getFreshness()).rejects.toThrow();
  });

  it("fails on purpose even when another read fails, since the switch decides first", async () => {
    const { svc } = service({ sync_run: { data: null, error: { message: "down" } } }, { app_test_switch: { data: true, error: null } }, true);
    await expect(svc.getFreshness()).rejects.toBeInstanceOf(InjectedFailureError);
  });

  it("throws when the test switch can't be read", async () => {
    const { svc } = service({}, { app_test_switch: { data: null, error: { message: "down" } } }, true);
    await expect(svc.getFreshness()).rejects.toThrow("app_test_switch failed: down");
  });
});

describe("freshness reconciliation comparison (R20, AC35, AC37, Q11)", () => {
  const run = (id: string, status: string, startedAt: string, storedTotal: string | null) => ({
    id,
    started_at: startedAt,
    finished_at: status === "running" ? null : startedAt,
    status,
    erp_total: storedTotal,
    stored_total: storedTotal,
    unexplained: storedTotal === null ? null : 0,
    error: status === "failed" ? "ERPNext unavailable" : null,
  });
  // reconciliation_run answers in query order: first the newest run (any state), then the newest succeeded one.
  const runs = (latest: unknown[], succeeded: unknown[]): Result[] => [
    { data: latest, error: null },
    { data: succeeded, error: null },
  ];

  it("reads the newest succeeded run with a status filter and ERPNext revenue for the reconciliation's period", async () => {
    const { svc, calls } = service();
    await svc.getFreshness();
    const reconciliationCalls = calls.filter((c) => c.table === "reconciliation_run");
    expect(reconciliationCalls[0]?.chain).not.toContainEqual(["eq", "status", "succeeded"]);
    expect(reconciliationCalls[1]?.chain).toContainEqual(["eq", "status", "succeeded"]);
    expect(reconciliationCalls[1]?.chain).toContainEqual(["order", "started_at", { ascending: false }]);
    expect(calls.find((c) => c.table === "monthly_revenue")?.chain).toEqual([
      ["select", "month, source, revenue"],
      ["eq", "source", "erpnext"],
      ["gte", "month", "2026-01-01"],
      ["lte", "month", "2026-12-01"],
    ]);
  });

  it.each(["running", "failed"])("compares with the previous successful run when the latest is %s", async (status) => {
    const result = await service({
      reconciliation_run: runs([run("r9", status, "2026-10-19T06:00:00Z", null)], [run("r8", "succeeded", "2026-10-18T06:00:00Z", "461664.00")]),
    }).svc.getFreshness();
    expect(result.reconciliation.latest).toMatchObject({ id: "r9", status, storedTotal: null });
    expect(result.reconciliation.lastSucceeded).toMatchObject({ id: "r8", storedTotal: "461664.00" });
    expect(result.reconciliation.comparison).toEqual({
      result: "matches",
      erpnextValidCents: 46166400,
      storedTotalCents: 46166400,
      runStartedAt: "2026-10-18T06:00:00Z",
    });
  });

  it("says ERPNext data changed since the run when the current figure differs by a cent", async () => {
    const result = await service({
      monthly_revenue: { data: [{ month: "2026-03-01", source: "erpnext", revenue: "461664.01" }], error: null },
    }).svc.getFreshness();
    expect(result.reconciliation.comparison).toEqual({
      result: "changed-since-run",
      erpnextValidCents: 46166401,
      storedTotalCents: 46166400,
      runStartedAt: "2026-10-18T06:00:00Z",
    });
  });

  it("doesn't fail when monthly_revenue fails: the comparison is unavailable and the rest still loads", async () => {
    const result = await service({ monthly_revenue: { data: null, error: { message: "down" } } }).svc.getFreshness();
    expect(result.reconciliation).toEqual({
      available: true,
      period: YEAR,
      latest: RUN_R1,
      lastSucceeded: RUN_R1,
      erpnextValidCents: null,
      comparison: { result: "unavailable" },
    });
    expect(result.erpnext.lastSuccessfulSync).toBe("2026-10-18T18:00:00+00:00");
    expect(result.alerts).toEqual([]);
  });

  it("uses the succeeded run as the latest when it is at least as new (the two reads raced a run finishing)", async () => {
    const result = await service({
      reconciliation_run: runs([run("r8", "running", "2026-10-19T06:00:00Z", null)], [run("r8", "succeeded", "2026-10-19T06:00:00Z", "461664.00")]),
    }).svc.getFreshness();
    expect(result.reconciliation.latest).toMatchObject({ id: "r8", status: "succeeded", storedTotal: "461664.00" });
    expect(result.reconciliation.latest).toEqual(result.reconciliation.lastSucceeded);
  });

  it("keeps a newer running run as the latest", async () => {
    const result = await service({
      reconciliation_run: runs([run("r9", "running", "2026-10-19T06:00:00Z", null)], [run("r8", "succeeded", "2026-10-18T06:00:00Z", "461664.00")]),
    }).svc.getFreshness();
    expect(result.reconciliation.latest).toMatchObject({ id: "r9", status: "running" });
  });

  it("offers no comparison when no run has succeeded", async () => {
    const result = await service({
      reconciliation_run: runs([run("r1", "failed", "2026-10-19T06:00:00Z", null)], []),
    }).svc.getFreshness();
    expect(result.reconciliation.lastSucceeded).toBeNull();
    expect(result.reconciliation.comparison).toEqual({ result: "no-successful-run", erpnextValidCents: 46166400 });
  });

  it("ignores Unit B rows: a change in Unit B data leaves the comparison unchanged", async () => {
    const before = (await service().svc.getFreshness()).reconciliation;
    const after = (
      await service({
        monthly_revenue: {
          data: [...(MONTHLY_REVENUE.data as unknown[]), { month: "2026-04-01", source: "legacy_unit_b", revenue: "109915.83" }],
          error: null,
        },
      }).svc.getFreshness()
    ).reconciliation;
    expect(after.erpnextValidCents).toBe(before.erpnextValidCents);
    expect(after.comparison).toEqual(before.comparison);
  });

  it("never reads the quarantine: an open quarantine row changes no figure", async () => {
    const { svc, calls } = service({ quarantine: { data: [{ source: "erpnext", source_doc_id: "ACC-SINV-1", status: "open" }], error: null } });
    const result = await svc.getFreshness();
    expect(calls.map((c) => c.table)).not.toContain("quarantine");
    expect(result.reconciliation.erpnextValidCents).toBe(46166400);
  });
});

describe("freshness round trips (R17)", () => {
  // R20 adds the newest succeeded reconciliation run and ERPNext valid revenue to the same round trip.
  const READS = [
    "consumer_heartbeat",
    "dead_letter",
    "monthly_revenue",
    "reconciliation_run",
    "reconciliation_run",
    "rpc:app_queue_metrics",
    "source_file",
    "source_file",
    "sync_run",
    "sync_run",
  ];

  function deferred(rpcs: Record<string, Result>, testSwitchesEnabled: boolean) {
    const fake = fakeSupabase(HEALTHY_TABLES, { ...HEALTHY_RPCS, ...rpcs }, { deferred: true });
    return { fake, svc: createFreshnessService(fake.client, { testSwitchesEnabled, now: NOW }) };
  }

  it("issues every read, the test switch included, in one round trip", async () => {
    const { fake, svc } = deferred({}, true);
    const promise = svc.getFreshness();
    await fake.settle();
    expect(issuedNames(fake)).toEqual([...READS, "rpc:app_test_switch"].sort());
    fake.releaseAll();
    expect((await promise).alerts).toEqual([]);
  });

  it("leaves the test switch out of the round trip when switches are disabled", async () => {
    const { fake, svc } = deferred({}, false);
    const promise = svc.getFreshness();
    await fake.settle();
    expect(issuedNames(fake)).toEqual(READS);
    fake.releaseAll();
    await promise;
    expect(fake.calls.some((call) => call.rpc === "app_test_switch")).toBe(false);
  });

  it("waits for every read before throwing the injected failure", async () => {
    const { fake, svc } = deferred({ app_test_switch: { data: true, error: null } }, true);
    let settled = false;
    const promise = svc.getFreshness().finally(() => {
      settled = true;
    });
    await fake.settle();
    fake.release("app_test_switch");
    await fake.settle();
    expect(settled).toBe(false);
    fake.releaseAll();
    await expect(promise).rejects.toBeInstanceOf(InjectedFailureError);
  });
});
