import { describe, expect, it, jest } from "@jest/globals";
import { isAuthorizedCron } from "../../supabase/functions/_shared/cron-auth.ts";
import { createConsumerHandler } from "../../src/http/consumer-handler.ts";
import type { BatchResult, ConsumerDeps, RpcClient } from "../../src/services/consumer-service.ts";

// T9: the invoice-consumer handler (the Edge Function is a thin Deno wrapper around it).
const URL = "http://localhost:54321/functions/v1/invoice-consumer";
const SECRET = "test-cron-secret";

// An empty queue: read returns nothing, the heartbeat succeeds.
const emptyQueue: RpcClient = { rpc: async () => ({ data: [], error: null }) };

function handlerWith(run?: (deps: ConsumerDeps) => Promise<BatchResult>) {
  return createConsumerHandler({
    isAuthorized: (req) => isAuthorizedCron(req, SECRET),
    buildDeps: () => ({ rpc: emptyQueue }),
    ...(run ? { run } : {}),
  });
}

function post(headers: Record<string, string> = { "x-cron-secret": SECRET }): Request {
  return new Request(URL, { method: "POST", headers, body: "{}" });
}

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ type: "about:blank", status, title: expect.any(String), detail: expect.any(String) });
  return body;
}

describe("invoice-consumer handler", () => {
  it("runs one batch and returns its counts", async () => {
    const response = await handlerWith()(post());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: 0, valid: 0, invalid: 0, cancelled: 0, removed: 0, stale: 0, skipped: 0, failed: 0, deadLettered: 0 });
  });

  it.each([
    ["missing", {}],
    ["wrong", { "x-cron-secret": "nope-nope-nope-nope" }],
  ])("returns 401 Problem Details for a %s cron secret, without running the batch", async (_label, headers) => {
    const run = jest.fn(async () => ({}) as BatchResult);
    const body = await expectProblem(await handlerWith(run)(post(headers)), 401);
    expect(body["title"]).toBe("Unauthorized");
    expect(run).not.toHaveBeenCalled();
  });

  it("returns 405 Problem Details with Allow: POST for other methods", async () => {
    const response = await handlerWith()(new Request(URL, { method: "GET", headers: { "x-cron-secret": SECRET } }));
    await expectProblem(response, 405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns 500 Problem Details when the batch throws", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = await expectProblem(
        await handlerWith(async () => {
          throw new Error("read_invoice_events failed: db down");
        })(post()),
        500,
      );
      expect(body["detail"]).toBe("read_invoice_events failed: db down");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 Problem Details naming the reason when the customer mapping is ambiguous", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const called: string[] = [];
    const rpc: RpcClient = {
      rpc: async (fn) => {
        called.push(fn);
        if (fn === "read_invoice_events") return { data: [{ msg_id: 1, read_ct: 1, enqueued_at: "2026-10-18T12:00:00Z", message: {} }], error: null };
        if (fn === "load_customer_index") {
          return {
            data: {
              mappingVersion: 1,
              aliases: [
                { source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" },
                { source: "legacy_unit_b", matchKey: "Acme Foods", canonicalId: "acme-co" },
              ],
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    try {
      const handler = createConsumerHandler({ isAuthorized: (req) => isAuthorizedCron(req, SECRET), buildDeps: () => ({ rpc }) });
      const body = await expectProblem(await handler(post()), 500);
      expect(body["detail"]).toMatch(/^customer mapping unusable, no message processed: .*ambiguous/);
      expect(called).toEqual(["read_invoice_events", "load_customer_index", "write_consumer_heartbeat"]);
    } finally {
      spy.mockRestore();
    }
  });
});
