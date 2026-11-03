import { describe, expect, it, jest } from "@jest/globals";
import { createHmac } from "node:crypto";
import { createErpnextWebhookHandler, SIGNATURE_HEADER } from "../../src/http/erpnext-webhook-handler.ts";
import type { RpcClient } from "../../src/services/poll-service.ts";

// T21: the erpnext-webhook handler (AC09). The Edge Function is a thin Deno wrapper around it.
const URL = "http://localhost:54321/functions/v1/erpnext-webhook";
const SECRET = "test-webhook-secret";
const BODY = '{"name": "ACC-SINV-2026-00001"}';
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");

function setup(options: { secret?: string; enqueue?: (rpc: RpcClient, name: string) => Promise<number> } = {}) {
  const enqueue = jest.fn(options.enqueue ?? (async () => 7));
  const handler = createErpnextWebhookHandler({
    secret: () => ("secret" in options ? options.secret : SECRET),
    buildRpc: () => ({ rpc: async () => ({ data: null, error: null }) }),
    enqueue,
  });
  return { handler, enqueue };
}

const post = (body: string, headers: Record<string, string>) =>
  new Request(URL, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ type: "about:blank", status, title: expect.any(String), detail: expect.any(String) });
  return body;
}

describe("erpnext-webhook handler", () => {
  it("enqueues a hint for a valid signature and returns 200", async () => {
    const t = setup();
    const response = await t.handler(post(BODY, { [SIGNATURE_HEADER]: sign(BODY) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: true, name: "ACC-SINV-2026-00001", msgId: 7 });
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.enqueue.mock.calls[0]![1]).toBe("ACC-SINV-2026-00001");
  });

  it("AC09: returns 401 Problem Details for an invalid signature and queues nothing", async () => {
    const t = setup();
    const body = await expectProblem(await t.handler(post(BODY, { [SIGNATURE_HEADER]: sign(BODY, "wrong-secret") })), 401);
    expect(body["title"]).toBe("Unauthorized");
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it("AC09: returns 401 Problem Details for a missing signature and queues nothing", async () => {
    const t = setup();
    await expectProblem(await t.handler(post(BODY, {})), 401);
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it("returns 401 for a body changed after signing", async () => {
    const t = setup();
    await expectProblem(await t.handler(post('{"name": "ACC-SINV-2026-00002"}', { [SIGNATURE_HEADER]: sign(BODY) })), 401);
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it.each(["GET", "PUT", "DELETE"])("returns 405 Problem Details with Allow: POST for %s", async (method) => {
    const t = setup();
    const response = await t.handler(new Request(URL, { method, headers: { [SIGNATURE_HEADER]: sign("") } }));
    await expectProblem(response, 405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it("returns 400 for a correctly signed body without a name", async () => {
    const t = setup();
    await expectProblem(await t.handler(post("{}", { [SIGNATURE_HEADER]: sign("{}") })), 400);
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it("returns 500 and queues nothing when the secret isn't configured", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = setup({ secret: undefined });
      await expectProblem(await t.handler(post(BODY, { [SIGNATURE_HEADER]: sign(BODY, "") })), 500);
      expect(t.enqueue).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 Problem Details when enqueueing fails", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = setup({
        enqueue: async () => {
          throw new Error("enqueue_hint failed: db down");
        },
      });
      const body = await expectProblem(await t.handler(post(BODY, { [SIGNATURE_HEADER]: sign(BODY) })), 500);
      expect(body["detail"]).toBe("enqueue_hint failed: db down");
    } finally {
      spy.mockRestore();
    }
  });
});
