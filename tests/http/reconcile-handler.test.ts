import { describe, expect, it, jest } from "@jest/globals";
import { isAuthorizedCron } from "../../supabase/functions/_shared/cron-auth.ts";
import { createReconcileHandler } from "../../src/http/reconcile-handler.ts";
import type { ReconcileDeps, ReconcileResult } from "../../src/services/reconciliation-service.ts";

// T16: the reconcile-erpnext handler (the Edge Function is a thin Deno wrapper around it).
const URL = "http://localhost:54321/functions/v1/reconcile-erpnext";
const SECRET = "test-cron-secret";
const OK: ReconcileResult = { runId: "run-1", status: "succeeded", erpTotal: "10.00", storedTotal: "10.00", unexplained: 0, differences: 0 };

function handlerWith(run: (deps: ReconcileDeps) => Promise<ReconcileResult>) {
  return createReconcileHandler({
    isAuthorized: (req) => isAuthorizedCron(req, SECRET),
    buildDeps: () => ({ rpc: { rpc: async () => ({ data: null, error: null }) }, erpnext: { baseUrl: "x", apiKey: "k", apiSecret: "s" } }),
    run,
  });
}

const post = (headers: Record<string, string> = { "x-cron-secret": SECRET }) => new Request(URL, { method: "POST", headers, body: "{}" });

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ type: "about:blank", status, title: expect.any(String), detail: expect.any(String) });
  return body;
}

describe("reconcile-erpnext handler", () => {
  it("runs one reconciliation and returns its summary", async () => {
    const response = await handlerWith(async () => OK)(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OK);
  });

  it.each([
    ["missing", {}],
    ["wrong", { "x-cron-secret": "nope-nope-nope-nope" }],
  ])("returns 401 Problem Details for a %s cron secret, without running", async (_label, headers) => {
    const run = jest.fn(async () => OK);
    await expectProblem(await handlerWith(run)(post(headers)), 401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 405 Problem Details with Allow: POST for other methods", async () => {
    const response = await handlerWith(async () => OK)(new Request(URL, { method: "GET", headers: { "x-cron-secret": SECRET } }));
    await expectProblem(response, 405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 500 Problem Details when the run can't be opened", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = await expectProblem(
        await handlerWith(async () => {
          throw new Error("start_reconciliation_run failed: db down");
        })(post()),
        500,
      );
      expect(body["detail"]).toBe("start_reconciliation_run failed: db down");
    } finally {
      spy.mockRestore();
    }
  });
});
