// Webhook service for Source A (PLAN "Source A: webhooks (P2)"; R02, EC02, AC08, AC09).
// Runtime-agnostic: Web Crypto (crypto.subtle) and atob exist in Node, Deno and the browser.
//
// The webhook is a latency hint, never a source of truth: it carries only the invoice name, and the
// current document is fetched through the adapter (resolveHint), so a late or reordered webhook can't
// apply stale data. Polling stays the backstop.

import { ErpNextAdapter } from "../core/adapters/erpnext/adapter.ts";
import { ErpNextHttpClient, ErpNextRequestError } from "../core/adapters/erpnext/http-client.ts";
import { COMPANY, ERP_HTTP_LIMITS, rawPathOf, SOURCE, toRecordMessage, type RecordMessage, type RpcClient } from "./poll-service.ts";

export type HintMessage = { v: 1; kind: "hint"; source: "erpnext"; sourceDocId: string };

// Frappe names are at most 140 characters.
const MAX_NAME_LENGTH = 140;

// X-Frappe-Webhook-Signature = base64(HMAC-SHA256(secret, raw body)). crypto.subtle.verify compares in
// constant time. A missing, non-base64 or wrong signature is simply false.
export async function verifyWebhookSignature(secret: string, rawBody: Uint8Array, signature: string | null): Promise<boolean> {
  if (!secret || !signature) return false;
  let given: Uint8Array;
  try {
    given = Uint8Array.from(atob(signature.trim()), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  if (given.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, given as Uint8Array<ArrayBuffer>, rawBody as Uint8Array<ArrayBuffer>);
}

// The configured request structure is {"name": "{{ doc.name }}"}. Anything else is malformed (null).
export function parseHintName(rawBody: Uint8Array): string | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const name = (body as Record<string, unknown>)["name"];
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed !== "" && trimmed.length <= MAX_NAME_LENGTH ? trimmed : null;
}

export function toHintMessage(name: string): HintMessage {
  return { v: 1, kind: "hint", source: SOURCE, sourceDocId: name };
}

// Queues one hint through the service_role wrapper (public.enqueue_hint). Returns the pgmq message id.
export async function enqueueHint(rpc: RpcClient, name: string): Promise<number> {
  const { data, error } = await rpc.rpc("enqueue_hint", { p_message: toHintMessage(name) });
  if (error) throw new Error(`enqueue_hint failed: ${error.message}`);
  return data as number;
}

export type HintResolution =
  | { outcome: "record"; message: RecordMessage }
  // A draft or another company's invoice: nothing to count.
  | { outcome: "skip"; reason: string }
  // Deleted in ERPNext: the deleted stream of the poll enqueues its tombstone (EC12), which carries the
  // deletion time the version needs; a hint alone can't build one.
  | { outcome: "gone" };

export type HintDeps = {
  erpnext: { baseUrl: string; apiKey: string; apiSecret: string };
  putRaw: (path: string, json: string) => Promise<void>;
  fetch?: typeof fetch; // tests only
  sleep?: (ms: number) => Promise<void>; // tests only
};

// Turns a hint into the same `record` message the poll would produce for the document's current version,
// writing its raw JSON first (a message never points at a missing object). ERPNext unavailable throws
// SourceUnavailableError: the caller drops the hint and polling catches up (PLAN, hints are best-effort).
export async function resolveHint(name: string, deps: HintDeps): Promise<HintResolution> {
  const client = new ErpNextHttpClient({
    ...deps.erpnext,
    ...ERP_HTTP_LIMITS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  let doc;
  try {
    doc = await new ErpNextAdapter({ client, company: COMPANY }).fetchDocument(name);
  } catch (error) {
    if (error instanceof ErpNextRequestError && error.status === 404) return { outcome: "gone" };
    throw error;
  }
  if (doc.docstatus !== 1 && doc.docstatus !== 2) return { outcome: "skip", reason: `docstatus ${String(doc.docstatus)}` };
  if (doc.company !== COMPANY) return { outcome: "skip", reason: `company ${String(doc.company)}` };
  await deps.putRaw(rawPathOf(doc), JSON.stringify(doc));
  return { outcome: "record", message: toRecordMessage(doc) };
}
