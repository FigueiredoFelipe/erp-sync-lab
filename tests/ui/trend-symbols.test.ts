import { describe, expect, it } from "@jest/globals";
import type { TrendLabel } from "../../src/core/trend/trend.ts";
import { TREND_SYMBOLS, trendSymbol, trendTipId } from "../../app/_components/trend-symbols.ts";

const LABELS: TrendLabel[] = ["growing", "declining", "stable", "new", "churned"];

describe("trend symbols", () => {
  it("gives each of the five labels a symbol", () => {
    for (const label of LABELS) expect(trendSymbol(label)).toMatch(/\S/);
    expect(Object.keys(TREND_SYMBOLS).sort()).toEqual([...LABELS].sort());
  });

  it("gives every label a different symbol", () => {
    expect(new Set(LABELS.map(trendSymbol)).size).toBe(LABELS.length);
  });

  it("tells declining and churned apart without color", () => {
    expect(trendSymbol("declining")).not.toBe(trendSymbol("churned"));
  });

  it("uses the planned symbols", () => {
    expect(TREND_SYMBOLS).toEqual({ growing: "▲", declining: "▼", stable: "■", new: "✦", churned: "✕" });
  });
});

describe("trendTipId", () => {
  it("is a valid IDREF for keys with spaces", () => {
    const id = trendTipId("unmapped:legacy_unit_b:Old Mill Tavern");
    expect(id).not.toMatch(/\s/);
    expect(id.startsWith("trend-tip-")).toBe(true);
  });

  it("keeps distinct keys distinct", () => {
    expect(trendTipId("a b")).not.toBe(trendTipId("a_b"));
  });
});
