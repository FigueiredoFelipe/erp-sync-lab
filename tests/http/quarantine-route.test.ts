import { describe, expect, it, jest } from "@jest/globals";
import * as route from "../../app/api/quarantine/route.ts";
import { createQuarantineHandler } from "../../src/http/quarantine-handler.ts";
import { createQuarantineService } from "../../src/services/quarantine-service.ts";
import { fakeSupabase, issuedNames, type Result } from "./fake-supabase.ts";

// T18: GET /api/quarantine — handler + quarantineService over a fake database client.
const URL_BASE = "http://localhost:3000/api/quarantine";

const ROWS = [
  { source: "legacy_unit_b", source_doc_id: "UB-26004", reason_code: "TOTAL_MISMATCH", detail: "INV_TOTAL 1452.40 vs line sum 1407.40", source_customer: "ACME FOODS", first_rejected_at: "2026-10-18T12:00:00Z", last_rejected_at: "2026-10-18T12:00:00Z" },
  { source: "legacy_unit_b", source_doc_id: "UB-26016", reason_code: "TOTAL_MISMATCH", detail: null, source_customer: "Old Mill Tavern", first_rejected_at: "2026-10-18T12:00:00Z", last_rejected_at: "2026-10-18T12:00:00Z" },
  { source: "legacy_unit_b", source_doc_id: "UB-26084", reason_code: "UNSUPPORTED_CURRENCY", detail: "EUR", source_customer: "REDWOOD  PIZZA KITCHEN", first_rejected_at: "2026-10-18T11:00:00Z", last_rejected_at: "2026-10-18T11:00:00Z" },
];

function handlerWith(result: Result, deferred = false) {
  const fake = fakeSupabase({ quarantine: result }, {}, { deferred });
  return { GET: createQuarantineHandler(() => createQuarantineService(fake.client)), calls: fake.calls, fake };
}

describe("GET /api/quarantine", () => {
  it("lists the open quarantine with counts per reason code", async () => {
    const { GET, calls } = handlerWith({ data: ROWS, error: null, count: 3 });
    const response = await GET(new Request(URL_BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as { count: number; byReason: unknown; entries: Record<string, unknown>[] };
    expect(body.count).toBe(3);
    expect(body.byReason).toEqual([
      { reasonCode: "TOTAL_MISMATCH", count: 2 },
      { reasonCode: "UNSUPPORTED_CURRENCY", count: 1 },
    ]);
    expect(body.entries[0]).toEqual({
      source: "legacy_unit_b",
      sourceDocId: "UB-26004",
      reasonCode: "TOTAL_MISMATCH",
      detail: "INV_TOTAL 1452.40 vs line sum 1407.40",
      sourceCustomer: "ACME FOODS",
      firstRejectedAt: "2026-10-18T12:00:00Z",
      lastRejectedAt: "2026-10-18T12:00:00Z",
    });
    // Only open entries: resolved ones are history, not something missing from the totals.
    expect(calls[0]?.chain).toContainEqual(["eq", "status", "open"]);
  });

  it("filters by source and reason", async () => {
    const { GET, calls } = handlerWith({ data: [], error: null, count: 0 });
    const response = await GET(new Request(`${URL_BASE}?source=erpnext&reason=PROCESSING_FAILED`));
    expect(response.status).toBe(200);
    expect(calls[0]?.chain).toEqual(expect.arrayContaining([["eq", "source", "erpnext"], ["eq", "reason_code", "PROCESSING_FAILED"]]));
  });

  it("answers in one round trip to the database", async () => {
    const { GET, fake } = handlerWith({ data: ROWS, error: null, count: 3 }, true);
    const pending = GET(new Request(URL_BASE));
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["quarantine"]);
    fake.releaseAll();
    expect((await pending).status).toBe(200);
  });

  it.each([
    ["source=csv", "'source' must be one of"],
    ["reason=WRONG_TOTAL", "'reason' must be one of"],
    ["status=resolved", "Unknown query parameter 'status'"],
  ])("rejects %s with 400 Problem Details", async (query, detail) => {
    const { GET, calls } = handlerWith({ data: [], error: null });
    const response = await GET(new Request(`${URL_BASE}?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ type: "about:blank", title: "Bad Request", status: 400 });
    expect(body["detail"]).toContain(detail);
    expect(calls).toHaveLength(0);
  });

  it("returns 500 Problem Details when the database fails or the list is truncated", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [
      { data: null, error: { message: "connection refused to secret-host" } },
      { data: ROWS, error: null, count: 1000 },
    ] as Result[]) {
      const { GET } = handlerWith(result);
      const response = await GET(new Request(URL_BASE));
      expect(response.status).toBe(500);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 500, detail: "Unexpected error while reading the quarantine." });
      expect(JSON.stringify(body)).not.toContain("secret-host");
    }
    spy.mockRestore();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)("answers %s with 405 and Allow: GET", async (method) => {
    const response = await route[method](new Request(URL_BASE, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});
