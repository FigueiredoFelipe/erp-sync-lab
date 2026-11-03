// Deterministic plan of the Unit B ("Source B") export: customers, planted cases and the invoices of each
// snapshot. Shared by the generator (scripts/legacy/generate-unit-b-export.ts), which writes the CSV files
// and READMEs, and by tests that need the same data without parsing the CSV (e.g. the AC07 trend test).
// Tooling outside the system (see specs/PLAN.md). No side effects on import.
import { buildSeedPlan, CUSTOMERS } from "../seed/data.ts";
import { createRng } from "../seed/random.ts";

export const RANDOM_SEED = 20261016;
export const EXPORT_DATE = "2026-10-16";
// AC17: a newer snapshot without one valid invoice, and an older snapshot that must be rejected whole.
export const NEWER_EXPORT_DATE = "2026-10-17";
export const OLDER_EXPORT_DATE = "2026-10-15";
export const MONTHS = 10;
export const LAST_DAY_OF_FINAL_MONTH = 15;

export type LegacyItem = { description: string; priceCents: number };

export const ITEMS: readonly LegacyItem[] = [
  { description: "FLOUR AP 50LB", priceCents: 2785 },
  { description: "OLIVE OIL EV 3L", priceCents: 4410 },
  { description: "TOMATO DICED #10 CS", priceCents: 3695 },
  { description: "RICE LG 25LB", priceCents: 2350 },
  { description: "SUGAR GRAN 25LB", priceCents: 2099 },
  { description: "PASTA PENNE 20LB", priceCents: 2640 },
  { description: "CANOLA OIL 35LB", priceCents: 3575 },
  { description: "BEANS BLACK #10 CS", priceCents: 3240 },
];

export type UnitBCustomer =
  // Shared with ERPNext under a different spelling; Unit B buys a share of what the ERPNext unit sells them.
  | { csvName: string; canonical: string; kind: "shared"; erpCode: string; share: number }
  | { csvName: string; canonical: string; kind: "only"; baseCents: number; monthlyChange: number; firstMonth: number };

export const UNIT_B_CUSTOMERS: readonly UnitBCustomer[] = [
  { csvName: "ACME FOODS", canonical: "Acme Foods Inc.", kind: "shared", erpCode: "ACME", share: 0.4 },
  { csvName: "Blue Ridge Kitchens LLC", canonical: "Blue Ridge Kitchens", kind: "shared", erpCode: "BLUERIDGE", share: 0.35 },
  { csvName: "Harbor Ln. Bistro", canonical: "Harbor Lane Bistro", kind: "shared", erpCode: "HARBORLANE", share: 0.5 },
  { csvName: "SUNSET GRILL AND TAPHOUSE", canonical: "Sunset Grill & Taphouse", kind: "shared", erpCode: "SUNSETGRILL", share: 0.3 },
  { csvName: "Lakeside Deli Company", canonical: "Lakeside Deli Co.", kind: "shared", erpCode: "LAKESIDE", share: 0.6 },
  { csvName: "REDWOOD  PIZZA KITCHEN", canonical: "Redwood Pizza Kitchen", kind: "shared", erpCode: "REDWOOD", share: 0.45 },
  { csvName: "Cedar Valley Bakery, Inc.", canonical: "Cedar Valley Bakery, Inc.", kind: "only", baseCents: 180000, monthlyChange: 0, firstMonth: 1 },
  { csvName: "Old Mill Tavern", canonical: "Old Mill Tavern", kind: "only", baseCents: 120000, monthlyChange: 0.08, firstMonth: 1 },
  { csvName: "Pinecrest Senior Living", canonical: "Pinecrest Senior Living", kind: "only", baseCents: 210000, monthlyChange: 0.03, firstMonth: 7 },
];

export type ReasonCode = "TOTAL_MISMATCH" | "MISSING_FIELD" | "INVALID_DATE" | "CONFLICTING_DUPLICATE" | "UNSUPPORTED_CURRENCY";

// Planted errors sit in January-March and October, outside every BR08 window (April-September),
// so AC04 (quarantine) and AC07 (trends) test independent things.
export type Plant =
  | { kind: "total_mismatch"; deltaCents: number }
  | { kind: "blank_customer" }
  | { kind: "invalid_date"; value: string }
  | { kind: "conflicting_total"; deltaCents: number }
  | { kind: "currency"; value: string }
  | { kind: "duplicate_row" }
  | { kind: "real_duplicate_lines" };

export const PLANTS: readonly { csvName: string; month: number; plant: Plant }[] = [
  { csvName: "ACME FOODS", month: 1, plant: { kind: "total_mismatch", deltaCents: 4500 } },
  { csvName: "Old Mill Tavern", month: 2, plant: { kind: "total_mismatch", deltaCents: -1250 } },
  { csvName: "Harbor Ln. Bistro", month: 10, plant: { kind: "total_mismatch", deltaCents: 10000 } },
  { csvName: "Cedar Valley Bakery, Inc.", month: 3, plant: { kind: "blank_customer" } },
  { csvName: "Lakeside Deli Company", month: 2, plant: { kind: "invalid_date", value: "02/30/2026" } },
  { csvName: "SUNSET GRILL AND TAPHOUSE", month: 1, plant: { kind: "conflicting_total", deltaCents: 2000 } },
  { csvName: "REDWOOD  PIZZA KITCHEN", month: 10, plant: { kind: "currency", value: "EUR" } },
  { csvName: "Blue Ridge Kitchens LLC", month: 3, plant: { kind: "duplicate_row" } },
];

// AC19: an extra October invoice whose identical repeated row is two real lines (INV_TOTAL counts both).
// It gets the next number after the regular invoices, so the numbers the spec cites stay stable.
export const REAL_DUPLICATE = { csvName: "Old Mill Tavern", month: 10, day: 15 } as const;

export type Line = { item: LegacyItem; qty: number };
export type UnitBInvoice = {
  invNo: string;
  customer: UnitBCustomer;
  month: number;
  day: number;
  lines: Line[];
  plant?: Plant;
};

export type UnitBExports = {
  // Seeded ERPNext revenue per customer name, in cents per month (index 0 = January 2026).
  erpMonthlyCents: Map<string, number[]>;
  // The main export (2026-10-16) and the two AC17 snapshots.
  invoices: UnitBInvoice[];
  newerSnapshot: UnitBInvoice[];
  olderSnapshot: UnitBInvoice[];
  removed: UnitBInvoice;
  removedQuarantined: UnitBInvoice;
};

export function buildUnitBExports(): UnitBExports {
  const rng = createRng(RANDOM_SEED);
  const seedPlan = buildSeedPlan();
  const erpMonthlyCents = monthlyErpRevenue(seedPlan.invoices);

  const drafts: Omit<UnitBInvoice, "invNo">[] = [];
  for (const customer of UNIT_B_CUSTOMERS) {
    for (let month = 1; month <= MONTHS; month++) {
      const target = monthlyTarget(customer, month, erpMonthlyCents, rng.between(-1, 1));
      if (target === 0) continue;
      const plant = PLANTS.find((p) => p.csvName === customer.csvName && p.month === month)?.plant;
      // A conflicting duplicate and a duplicated row both need an invoice with at least two lines.
      const minLines = plant?.kind === "conflicting_total" || plant?.kind === "duplicate_row" ? 2 : 1;
      const lineCount = Math.max(minLines, rng.int(1, 3));
      const items = rng.sample(ITEMS, lineCount);
      const weights = items.map(() => rng.between(0.6, 1.4));
      const weightSum = weights.reduce((sum, w) => sum + w, 0);
      const lines = items.map((item, i) => ({
        item,
        qty: Math.max(1, Math.round((target * (weights[i] as number)) / weightSum / item.priceCents)),
      }));
      const maxDay = month === MONTHS ? LAST_DAY_OF_FINAL_MONTH : 28;
      drafts.push({ customer, month, day: rng.int(1, maxDay), lines, plant });
    }
  }

  for (const plant of PLANTS) {
    if (!drafts.some((d) => d.customer.csvName === plant.csvName && d.month === plant.month && d.plant === plant.plant)) {
      throw new Error(`Planted error has no invoice: ${plant.csvName} ${plant.month}`);
    }
  }

  // Legacy systems number invoices in posting order.
  drafts.sort((a, b) => a.month - b.month || a.day - b.day || a.customer.csvName.localeCompare(b.customer.csvName));
  const invoices: UnitBInvoice[] = drafts.map((d, i) => ({ ...d, invNo: `UB-${String(26000 + i + 1)}` }));

  const realDuplicateCustomer = UNIT_B_CUSTOMERS.find((c) => c.csvName === REAL_DUPLICATE.csvName) as UnitBCustomer;
  const [repeated, other] = rng.sample(ITEMS, 2) as [LegacyItem, LegacyItem];
  const repeatedLine = { item: repeated, qty: rng.int(8, 20) };
  invoices.push({
    invNo: `UB-${String(26000 + invoices.length + 1)}`,
    customer: realDuplicateCustomer,
    month: REAL_DUPLICATE.month,
    day: REAL_DUPLICATE.day,
    lines: [repeatedLine, { ...repeatedLine }, { item: other, qty: rng.int(8, 20) }],
    plant: { kind: "real_duplicate_lines" },
  });

  // AC17 fixtures: the newer file drops the first valid January invoice of a shared customer (it must
  // leave the figures) and the invalid-date invoice (its open quarantine entry must be closed);
  // the older file is the snapshot as of its own date (invoices dated before 2026-10-15).
  const removed = invoices.find((inv) => inv.month === 1 && inv.plant === undefined && inv.customer.kind === "shared") as UnitBInvoice;
  const removedQuarantined = invoices.find((inv) => inv.plant?.kind === "invalid_date") as UnitBInvoice;
  const newerSnapshot = invoices.filter((inv) => inv !== removed && inv !== removedQuarantined);
  const olderSnapshot = invoices.filter((inv) => inv.month < 10 || inv.day < 15);

  return { erpMonthlyCents, invoices, newerSnapshot, olderSnapshot, removed, removedQuarantined };
}

export function monthlyTarget(customer: UnitBCustomer, month: number, erp: Map<string, number[]>, noise: number): number {
  if (customer.kind === "shared") {
    const erpCents = erp.get(erpNameOf(customer.erpCode))?.[month - 1] ?? 0;
    return erpCents * customer.share * (1 + 0.08 * noise);
  }
  if (month < customer.firstMonth) return 0;
  return customer.baseCents * (1 + customer.monthlyChange) ** (month - customer.firstMonth) * (1 + 0.06 * noise);
}

// A record is in the figures unless a planted error rejects it; repeated rows are arbitrated, not rejected.
export function isValid(invoice: UnitBInvoice): boolean {
  return invoice.plant === undefined || invoice.plant.kind === "duplicate_row" || invoice.plant.kind === "real_duplicate_lines";
}

// The duplicate_row copy is added only when writing rows, so lines hold each real line once.
export function invoiceCents(invoice: UnitBInvoice): number {
  return invoice.lines.reduce((sum, line) => sum + line.qty * line.item.priceCents, 0);
}

export function monthlyErpRevenue(invoices: ReturnType<typeof buildSeedPlan>["invoices"]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const inv of invoices.filter((i) => i.docstatus === 1)) {
    const months = result.get(inv.customerName) ?? zeros();
    months[Number(inv.postingDate.slice(5, 7)) - 1]! += Math.round(inv.total * 100);
    result.set(inv.customerName, months);
  }
  return result;
}

export function erpNameOf(code: string): string {
  const customer = CUSTOMERS.find((c) => c.code === code);
  if (!customer) throw new Error(`Unknown seed customer code ${code}`);
  return customer.name;
}

export function zeros(): number[] {
  return Array.from({ length: MONTHS }, () => 0);
}
