import { describe, expect, it } from "@jest/globals";
import { SourceUnavailableError } from "../../sync/contracts.ts";
import { ErpNextHttpClient, ErpNextRequestError, ReadOnlyViolationError } from "./http-client.ts";
import { jsonResponse, loadFixture, scriptedFetch, type ScriptedReply } from "./test-helpers.ts";

const API_KEY = "test-key";
const API_SECRET = "test-secret";

function makeClient(replies: ScriptedReply[], maxAttempts = 3) {
  const scripted = scriptedFetch(replies);
  const sleeps: number[] = [];
  const client = new ErpNextHttpClient({
    baseUrl: "https://erp.example.test/",
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    maxAttempts,
    baseDelayMs: 100,
    maxDelayMs: 5_000,
    fetch: scripted.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { client, calls: scripted.calls, sleeps };
}

describe("ErpNextHttpClient", () => {
  it("sends a GET with token auth and JSON-encoded query parameters", async () => {
    const { client, calls } = makeClient([jsonResponse({ data: [] })]);

    await client.get("/api/resource/Sales%20Invoice", { filters: [["docstatus", "=", 1]], limit: 5, order_by: "name asc" });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://erp.example.test/api/resource/Sales%20Invoice");
    expect(url.searchParams.get("filters")).toBe('[["docstatus","=",1]]');
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("order_by")).toBe("name asc");
    expect(calls[0]!.init?.method).toBe("GET");
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(`token ${API_KEY}:${API_SECRET}`);
  });

  it("retries 429 honoring Retry-After, then 5xx with exponential backoff, then succeeds", async () => {
    const { client, calls, sleeps } = makeClient(
      [jsonResponse({}, 429, { "Retry-After": "2" }), jsonResponse({}, 503), jsonResponse({ data: ["ok"] })],
      3,
    );

    const res = await client.get<{ data: string[] }>("/api/resource/Sales%20Invoice");

    expect(res.data).toEqual(["ok"]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 200]);
  });

  it("caps Retry-After at maxDelayMs", async () => {
    const { client, sleeps } = makeClient([jsonResponse({}, 429, { "Retry-After": "3600" }), jsonResponse({ data: [] })]);
    await client.get("/x");
    expect(sleeps).toEqual([5_000]);
  });

  it("retries network errors and timeouts", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const { client, calls } = makeClient([new TypeError("fetch failed"), timeout, jsonResponse({ data: 1 })]);

    await expect(client.get("/x")).resolves.toEqual({ data: 1 });
    expect(calls).toHaveLength(3);
  });

  it("throws SourceUnavailableError when retries are exhausted", async () => {
    const { client, calls, sleeps } = makeClient([jsonResponse({}, 502), jsonResponse({}, 500), jsonResponse({}, 504)], 3);

    const error = await client.get("/api/resource/Sales%20Invoice", { limit: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect((error as Error).message).toContain("after 3 attempts (last: HTTP 504)");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry other 4xx and decodes the Frappe message (recorded 404)", async () => {
    const { client, calls } = makeClient([jsonResponse(loadFixture("error-404.json"), 404)]);

    const error = await client.get("/api/resource/Sales%20Invoice/ACC-SINV-DOES-NOT-EXIST").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErpNextRequestError);
    expect((error as ErpNextRequestError).status).toBe(404);
    expect((error as Error).message).toBe(
      "GET /api/resource/Sales%20Invoice/ACC-SINV-DOES-NOT-EXIST failed with 404: DoesNotExistError | Sales Invoice ACC-SINV-DOES-NOT-EXIST not found",
    );
    expect(calls).toHaveLength(1);
  });

  it("never puts credentials or the query string in error messages", async () => {
    const { client } = makeClient([jsonResponse({ exc_type: "PermissionError" }, 403)]);
    const error = (await client.get("/x", { filters: [["secret-filter", "=", 1]] }).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(API_SECRET);
    expect(error.message).not.toContain("secret-filter");

    const exhausted = makeClient([jsonResponse({}, 500)], 1);
    const unavailable = (await exhausted.client.get("/x").catch((e: unknown) => e)) as Error;
    expect(unavailable.message).not.toContain(API_SECRET);
  });

  describe("BR09: read-only toward sources", () => {
    it("exposes no write methods", () => {
      const { client } = makeClient([]);
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client)).filter((m) => m !== "constructor");
      expect(methods.sort()).toEqual(["get", "request"]);
      for (const write of ["post", "put", "patch", "delete", "create", "update", "insert", "submit", "cancel"]) {
        expect((client as unknown as Record<string, unknown>)[write]).toBeUndefined();
      }
    });

    it.each(["POST", "PUT", "PATCH", "DELETE", "post", "HEAD"])("refuses %s before any request is made", async (method) => {
      const { client, calls } = makeClient([jsonResponse({ data: {} })]);
      await expect(client.request(method, "/api/resource/Sales%20Invoice")).rejects.toBeInstanceOf(ReadOnlyViolationError);
      expect(calls).toHaveLength(0);
    });
  });
});
