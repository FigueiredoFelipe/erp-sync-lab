import { describe, expect, it } from "@jest/globals";
import { createHmac } from "node:crypto";
import type { ErpInvoiceDoc } from "../core/adapters/erpnext/adapter.ts";
import { SourceUnavailableError } from "../core/sync/contracts.ts";
import { jsonResponse, loadFixture, scriptedFetch } from "../core/adapters/erpnext/test-helpers.ts";
import { rawPathOf, toRecordMessage } from "./poll-service.ts";
import { enqueueHint, parseHintName, resolveHint, toHintMessage, verifyWebhookSignature } from "./webhook-service.ts";

// T21: webhook signature, hint parsing, enqueueing and resolution (R02, AC09).
const SECRET = "test-webhook-secret";
const bytes = (text: string) => new TextEncoder().encode(text);
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64");
const BODY = '{"name": "ACC-SINV-2026-00001"}';

describe("verifyWebhookSignature", () => {
  it("accepts base64(HMAC-SHA256(secret, raw body))", async () => {
    expect(await verifyWebhookSignature(SECRET, bytes(BODY), sign(SECRET, BODY))).toBe(true);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["signed with another secret", sign("other-secret", BODY)],
    ["signed over another body", sign(SECRET, '{"name": "ACC-SINV-2026-00002"}')],
    ["not base64", "%%%not-base64%%%"],
    ["truncated", sign(SECRET, BODY).slice(0, 20)],
    ["hex instead of base64", createHmac("sha256", SECRET).update(BODY).digest("hex")],
  ])("rejects a signature that is %s", async (_label, signature) => {
    expect(await verifyWebhookSignature(SECRET, bytes(BODY), signature)).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    expect(await verifyWebhookSignature("", bytes(BODY), sign("", BODY))).toBe(false);
  });

  it("covers the exact bytes: re-serialized JSON doesn't verify", async () => {
    expect(await verifyWebhookSignature(SECRET, bytes('{"name":"ACC-SINV-2026-00001"}'), sign(SECRET, BODY))).toBe(false);
  });
});

describe("parseHintName", () => {
  it("reads the name of the configured request structure", () => {
    expect(parseHintName(bytes(BODY))).toBe("ACC-SINV-2026-00001");
    expect(parseHintName(bytes('{"name": " ACC-SINV-2026-00001-1 ", "extra": 1}'))).toBe("ACC-SINV-2026-00001-1");
  });

  it.each([["not json", "name=x"], ["an array", "[]"], ["no name", "{}"], ["a number", '{"name": 12}'], ["blank", '{"name": "  "}'], ["too long", JSON.stringify({ name: "x".repeat(141) })]])(
    "returns null for %s",
    (_label, body) => {
      expect(parseHintName(bytes(body))).toBeNull();
    },
  );
});

describe("enqueueHint", () => {
  it("sends exactly the hint contract through public.enqueue_hint", async () => {
    const calls: { fn: string; args: object }[] = [];
    const id = await enqueueHint({ rpc: async (fn, args) => (calls.push({ fn, args }), { data: 42, error: null }) }, "ACC-SINV-2026-00001");
    expect(id).toBe(42);
    expect(calls).toEqual([{ fn: "enqueue_hint", args: { p_message: { v: 1, kind: "hint", source: "erpnext", sourceDocId: "ACC-SINV-2026-00001" } } }]);
    expect(toHintMessage("A")).toStrictEqual({ v: 1, kind: "hint", source: "erpnext", sourceDocId: "A" });
  });

  it("throws on a database error", async () => {
    await expect(enqueueHint({ rpc: async () => ({ data: null, error: { message: "boom" } }) }, "A")).rejects.toThrow("enqueue_hint failed: boom");
  });
});

describe("resolveHint", () => {
  const listed = loadFixture<{ data: ErpInvoiceDoc[] }>("changed-page-1.json").data[0]!;
  // A single-doc GET returns many more fields than the list query; resolveHint keeps the same ones.
  const full = { ...listed, owner: "Administrator", grand_total: 999, items: (listed.items ?? []).map((i) => ({ ...i, warehouse: "Stores" })) };
  const ERP = { baseUrl: "https://erp.example.test", apiKey: "k", apiSecret: "s" };

  function deps(reply: Response | Response[]) {
    const raw = new Map<string, string>();
    const { fetch, calls } = scriptedFetch(Array.isArray(reply) ? reply : [reply]);
    return { raw, calls, deps: { erpnext: ERP, fetch, sleep: async () => {}, putRaw: async (p: string, j: string) => void raw.set(p, j) } };
  }

  it("returns the same record message the poll would produce, after writing its raw JSON", async () => {
    const t = deps(jsonResponse({ data: full }));
    const resolution = await resolveHint(listed.name!, t.deps);
    expect(resolution).toEqual({ outcome: "record", message: toRecordMessage(listed) });
    expect(JSON.parse(t.raw.get(rawPathOf(listed))!)).toEqual(listed);
    expect(t.calls[0]!.url).toBe("https://erp.example.test/api/resource/Sales%20Invoice/ACC-SINV-2026-00001");
    expect(t.calls[0]!.init?.method).toBe("GET");
  });

  it("returns a cancellation as a 2| record", async () => {
    const t = deps(jsonResponse({ data: { ...full, docstatus: 2 } }));
    const resolution = await resolveHint(listed.name!, t.deps);
    expect(resolution.outcome === "record" && resolution.message.sourceVersion.startsWith("2|")).toBe(true);
  });

  it("skips a draft and another company's invoice, writing nothing", async () => {
    const draft = deps(jsonResponse({ data: { ...full, docstatus: 0 } }));
    expect(await resolveHint("X", draft.deps)).toEqual({ outcome: "skip", reason: "docstatus 0" });
    const other = deps(jsonResponse({ data: { ...full, company: "Other Co" } }));
    expect(await resolveHint("X", other.deps)).toEqual({ outcome: "skip", reason: "company Other Co" });
    expect(draft.raw.size + other.raw.size).toBe(0);
  });

  it("reports a deleted invoice (404) as gone, for the deleted stream to tombstone", async () => {
    const t = deps(jsonResponse({ exc_type: "DoesNotExistError" }, 404));
    expect(await resolveHint("ACC-SINV-2026-00099", t.deps)).toEqual({ outcome: "gone" });
  });

  it("throws SourceUnavailableError when ERPNext is down, so the caller can drop the hint", async () => {
    const t = deps([jsonResponse({}, 502), jsonResponse({}, 502)]);
    await expect(resolveHint("A", t.deps)).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});
