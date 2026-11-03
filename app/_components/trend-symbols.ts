// The symbol each trend label carries next to its text (R21, AC40), so no trend is told by color alone:
// declining and churned share the critical color but never a symbol.
import type { TrendLabel } from "../../src/core/trend/trend.ts";

export const TREND_SYMBOLS: Readonly<Record<TrendLabel, string>> = {
  growing: "▲",
  declining: "▼",
  stable: "■",
  new: "✦",
  churned: "✕",
};

export function trendSymbol(label: TrendLabel): string {
  return TREND_SYMBOLS[label];
}

// The trend tooltip's element id. Customer keys may hold spaces ("unmapped:<source>:<name>"), which an
// IDREF in aria-describedby cannot, so the key is URI-encoded.
export function trendTipId(key: string): string {
  return `trend-tip-${encodeURIComponent(key)}`;
}
