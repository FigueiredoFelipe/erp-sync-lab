import { describe, expect, it } from "@jest/globals";
import { asOfDate, dateInZone, isCompleteMonth, lastDayOfMonth, monthFromIndex, monthIndex } from "./as-of.ts";

describe("asOfDate (BR08 as-of date)", () => {
  it("takes the earlier of the last ERPNext sync and the newest Source B export", () => {
    expect(asOfDate({ erpnextLastSync: "2026-10-18", sourceBNewestExport: "2026-10-16", today: "2026-10-20" })).toEqual({
      date: "2026-10-16",
      basis: "both",
    });
    expect(asOfDate({ erpnextLastSync: "2026-10-15", sourceBNewestExport: "2026-10-17", today: "2026-10-20" })).toEqual({
      date: "2026-10-15",
      basis: "both",
    });
  });

  it("uses the only source available", () => {
    expect(asOfDate({ erpnextLastSync: "2026-10-18", sourceBNewestExport: null, today: "2026-10-20" })).toEqual({
      date: "2026-10-18",
      basis: "erpnext",
    });
    expect(asOfDate({ erpnextLastSync: null, sourceBNewestExport: "2026-10-17", today: "2026-10-20" })).toEqual({
      date: "2026-10-17",
      basis: "legacy_unit_b",
    });
  });

  it("falls back to today when neither source has data", () => {
    expect(asOfDate({ erpnextLastSync: null, sourceBNewestExport: null, today: "2026-10-20" })).toEqual({
      date: "2026-10-20",
      basis: "today",
    });
  });
});

describe("dateInZone", () => {
  it("returns the calendar date in US Eastern time", () => {
    // 02:30 UTC on Oct 19 is still Oct 18 in New York (EDT, UTC-4).
    expect(dateInZone("2026-10-19T02:30:00Z")).toBe("2026-10-18");
    expect(dateInZone("2026-10-19T04:30:00Z")).toBe("2026-10-19");
  });

  it("rejects an invalid instant", () => {
    expect(() => dateInZone("not a date")).toThrow("Not a valid instant");
  });
});

describe("complete months (BR08)", () => {
  it("knows each month's last day, leap years included", () => {
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-09")).toBe("2026-09-30");
    expect(lastDayOfMonth("2026-12")).toBe("2026-12-31");
  });

  it("is complete only when its last day is before the as-of date", () => {
    expect(isCompleteMonth("2026-09", "2026-10-16")).toBe(true);
    expect(isCompleteMonth("2026-10", "2026-10-16")).toBe(false);
    // The last day itself is not before the as-of date: the month is still partial.
    expect(isCompleteMonth("2026-10", "2026-10-31")).toBe(false);
    expect(isCompleteMonth("2026-10", "2026-11-01")).toBe(true);
  });

  it("converts months to indexes and back", () => {
    expect(monthFromIndex(monthIndex("2026-01") - 1)).toBe("2025-12");
    expect(monthFromIndex(monthIndex("2026-12") + 1)).toBe("2027-01");
  });
});
