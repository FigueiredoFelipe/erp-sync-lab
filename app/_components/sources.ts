// Display names of the canonical sources, shared by every page that names a source (Customers filter,
// Revenue chart legend and tooltip; R19 requires the chart to use the filter's names).
import type { SourceId } from "../../src/core/canonical.ts";

export const SOURCE_LABELS: Record<SourceId, string> = {
  erpnext: "ERPNext (Unit A)",
  legacy_unit_b: "Unit B export",
};

// Short names, where the full label doesn't fit (a table cell, a qualifier in a heading or an option).
export const SOURCE_SHORT_LABELS: Record<SourceId, string> = {
  erpnext: "ERPNext",
  legacy_unit_b: "Unit B",
};

// The short name of a source id that arrives as a plain string (API payloads, option keys); an id outside
// the canonical list is shown as is rather than mislabelled.
export function shortSourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_SHORT_LABELS, source) ? SOURCE_SHORT_LABELS[source as SourceId] : source;
}
