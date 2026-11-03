import { describe, expect, it } from "@jest/globals";
import { fakeSupabase, issuedNames } from "../../tests/http/fake-supabase.ts";
import { createQuarantineService } from "./quarantine-service.ts";

const ROW = {
  source: "erpnext",
  source_doc_id: "ACC-SINV-2026-00007",
  reason_code: "UNKNOWN_CUSTOMER",
  detail: null,
  source_customer: "Mystery",
  first_rejected_at: "2026-10-18T10:00:00Z",
  last_rejected_at: "2026-10-18T11:00:00Z",
};

describe("quarantineService.listOpen", () => {
  it("reads the open quarantine in one round trip", async () => {
    const fake = fakeSupabase({ quarantine: { data: [ROW], error: null, count: 1 } }, {}, { deferred: true });
    const promise = createQuarantineService(fake.client).listOpen({ source: "erpnext", reason: null });
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["quarantine"]);
    fake.releaseAll();
    const result = await promise;
    expect(result.count).toBe(1);
    expect(result.byReason).toEqual([{ reasonCode: "UNKNOWN_CUSTOMER", count: 1 }]);
    expect(fake.calls[0]?.chain).toEqual(
      expect.arrayContaining([
        ["eq", "status", "open"],
        ["eq", "source", "erpnext"],
      ]),
    );
  });

  it("refuses a truncated list and throws on a database error", async () => {
    await expect(createQuarantineService(fakeSupabase({ quarantine: { data: [ROW], error: null, count: 2 } }).client).listOpen({ source: null, reason: null })).rejects.toThrow(
      "refusing a partial list",
    );
    await expect(createQuarantineService(fakeSupabase({ quarantine: { data: null, error: { message: "down" } } }).client).listOpen({ source: null, reason: null })).rejects.toThrow(
      "quarantine query failed: down",
    );
  });
});
