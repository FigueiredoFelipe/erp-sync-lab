// POST erpnext-webhook (called by ERPNext's Webhook on Sales Invoice; deployed with verify_jwt = false)
// — thin handler: read the raw body, verify the HMAC signature, enqueue a hint. It never processes
// (constitution: the webhook handler only validates and enqueues). Runtime-agnostic; the Edge Function
// injects the secret and the database RPC.
import type { RpcClient } from "../services/poll-service.ts";
import { enqueueHint, parseHintName, verifyWebhookSignature } from "../services/webhook-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";

export const SIGNATURE_HEADER = "x-frappe-webhook-signature";

export type WebhookHandlerDeps = {
  secret: () => string | undefined;
  buildRpc: () => RpcClient;
  enqueue?: (rpc: RpcClient, name: string) => Promise<number>;
};

export function createErpnextWebhookHandler({ secret, buildRpc, enqueue = enqueueHint }: WebhookHandlerDeps) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return problemResponse(405, `Method ${request.method} is not allowed; use POST.`, { allow: "POST" });
    }
    const key = secret();
    if (!key) {
      console.error("erpnext-webhook: ERPNEXT_WEBHOOK_SECRET is not set");
      return problemResponse(500, "The webhook is not configured.");
    }
    // The signature covers the exact bytes ERPNext sent, so read them before any parsing.
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!(await verifyWebhookSignature(key, raw, request.headers.get(SIGNATURE_HEADER)))) {
      return problemResponse(401, `Missing or invalid ${SIGNATURE_HEADER} header.`);
    }
    const name = parseHintName(raw);
    if (name === null) {
      return problemResponse(400, 'The body must be JSON like {"name": "<Sales Invoice name>"}.');
    }
    try {
      const msgId = await enqueue(buildRpc(), name);
      return jsonResponse({ queued: true, name, msgId });
    } catch (error) {
      console.error("erpnext-webhook: enqueue failed", error);
      return problemResponse(500, error instanceof Error ? error.message : String(error));
    }
  };
}
