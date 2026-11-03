import { describe, expect, it } from "@jest/globals";
import { trend } from "./trend.ts";

// As-of 2026-10-16: complete months are up to September; last 3 = Jul–Sep, previous 3 = Apr–Jun, last 2 = Aug–Sep.
const AS_OF = "2026-10-16";

function history(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

// Same cents in every month of the window.
function months(from: number, to: number, cents: number): Record<string, number> {
  const result: Record<string, number> = {};
  for (let m = from; m <= to; m++) result[`2026-${String(m).padStart(2, "0")}`] = cents;
  return result;
}

describe("trend (BR08 v4)", () => {
  it("uses the complete months before the as-of date as windows", () => {
    const result = trend(history({}), AS_OF);
    expect(result.lastCompleteMonth).toBe("2026-09");
    expect(result.last3).toEqual(["2026-07", "2026-09"]);
    expect(result.prev3).toEqual(["2026-04", "2026-06"]);
    // On the last day of October, October is still incomplete; on November 1st it is complete.
    expect(trend(history({}), "2026-10-31").lastCompleteMonth).toBe("2026-09");
    expect(trend(history({}), "2026-11-01").lastCompleteMonth).toBe("2026-10");
  });

  it("ignores the partial month in the sums", () => {
    const result = trend(history({ ...months(4, 9, 1000), "2026-10": 999_999 }), AS_OF);
    expect([result.prev3Cents, result.last3Cents]).toEqual([3000, 3000]);
  });

  describe("rule 1, churned", () => {
    it("revenue before the last 2 complete months and none in them", () => {
      expect(trend(history(months(1, 7, 1000)), AS_OF)).toMatchObject({ label: "churned", rule: 1 });
    });

    it("counts history before the 6-month window (stopped in March)", () => {
      expect(trend(history(months(1, 3, 1000)), AS_OF)).toMatchObject({ label: "churned", rule: 1 });
    });

    it("wins over growth: a single July purchase then nothing (known limitation)", () => {
      expect(trend(history({ "2026-07": 5000 }), AS_OF)).toMatchObject({ label: "churned", rule: 1 });
    });

    it("is not churned with revenue in either of the last 2 months", () => {
      expect(trend(history({ ...months(1, 7, 1000), "2026-09": 1 }), AS_OF).label).not.toBe("churned");
      expect(trend(history({ ...months(1, 7, 1000), "2026-08": 1 }), AS_OF).label).not.toBe("churned");
    });

    it("treats a net zero or negative month (credit notes) as no revenue", () => {
      expect(trend(history({ ...months(1, 7, 1000), "2026-08": 0, "2026-09": -500 }), AS_OF).label).toBe("churned");
    });
  });

  describe("rule 2, new", () => {
    it("first month with revenue is one of the last 3", () => {
      expect(trend(history(months(7, 10, 1000)), AS_OF)).toMatchObject({ label: "new", rule: 2 });
      expect(trend(history(months(9, 9, 1000)), AS_OF)).toMatchObject({ label: "new", rule: 2 });
    });

    it("looks at the whole history: an earlier purchase makes it not new", () => {
      expect(trend(history({ "2026-01": 100, ...months(7, 9, 1000) }), AS_OF)).toMatchObject({ label: "growing", rule: 3 });
    });

    it("a first purchase only in the partial month is not new (and is stable: nothing complete)", () => {
      expect(trend(history({ "2026-10": 1000 }), AS_OF)).toMatchObject({ label: "stable", rule: 3 });
    });
  });

  describe("rule 3, previous 3 ≤ 0", () => {
    it("growing when the last 3 are positive (bought in Feb and Sep, nothing Apr–Jun)", () => {
      expect(trend(history({ "2026-02": 1000, "2026-09": 1000 }), AS_OF)).toMatchObject({ label: "growing", rule: 3, prev3Cents: 0 });
    });

    it("stable when the last 3 are not positive", () => {
      expect(trend(history({ "2026-02": 1000, "2026-05": -200, "2026-06": 200, "2026-08": 1, "2026-09": -1 }), AS_OF)).toMatchObject({
        label: "stable",
        rule: 3,
      });
    });

    it("a negative previous 3 never divides or flips the comparison", () => {
      expect(trend(history({ "2026-01": 1000, "2026-04": -5000, "2026-09": 10 }), AS_OF)).toMatchObject({ label: "growing", rule: 3, prev3Cents: -5000 });
    });
  });

  describe("rules 4–6, thresholds in exact cents", () => {
    // prev3 = 3 × 1000 = 3000 cents; ×1.15 = 3450; ×0.85 = 2550.
    const base = months(1, 6, 1000);
    const last3 = (julAug: number, sep: number) => history({ ...base, "2026-07": julAug, "2026-08": julAug, "2026-09": sep });

    it("growing only strictly above prev3 × 1.15", () => {
      expect(trend(last3(1150, 1151), AS_OF)).toMatchObject({ label: "growing", rule: 4, last3Cents: 3451 });
      expect(trend(last3(1150, 1150), AS_OF)).toMatchObject({ label: "stable", rule: 6, last3Cents: 3450 });
    });

    it("declining only strictly below prev3 × 0.85", () => {
      expect(trend(last3(850, 849), AS_OF)).toMatchObject({ label: "declining", rule: 5, last3Cents: 2549 });
      expect(trend(last3(850, 850), AS_OF)).toMatchObject({ label: "stable", rule: 6, last3Cents: 2550 });
    });

    it("has no floating-point drift exactly on the threshold", () => {
      // In floats 100 * 1.15 = 114.99999999999999, so a float comparison would call 115 "growing".
      const h = history({ "2026-01": 1, "2026-04": 100, "2026-07": 114, "2026-08": 0, "2026-09": 1 });
      expect(trend(h, AS_OF)).toMatchObject({ label: "stable", rule: 6, prev3Cents: 100, last3Cents: 115 });
      const h2 = history({ "2026-01": 1, "2026-04": 100, "2026-07": 115, "2026-08": 0, "2026-09": 1 });
      expect(trend(h2, AS_OF)).toMatchObject({ label: "growing", rule: 4, last3Cents: 116 });
    });
  });

  it("refuses amounts that are not integer cents", () => {
    expect(() => trend(history({ "2026-01": 10.5 }), AS_OF)).toThrow("integer cents");
  });
});
