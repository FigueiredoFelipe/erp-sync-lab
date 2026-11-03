import { createRng } from "./random.ts";

export const SEED_PREFIX = "SEED";
const RANDOM_SEED = 20261020;
const YEAR = 2026;
const MONTHS = 10; // January to October 2026
// October stops before today (2026-10-17) so no invoice is posted in the future, independent of run date.
const LAST_DAY_OF_FINAL_MONTH = 15;
const DRAFT_POSTING_DATE = "2026-10-16";

export type SeedItem = {
  code: string;
  name: string;
  rate: number;
};

// Non-stock items so invoices can be submitted without stock entries.
export const ITEMS: readonly SeedItem[] = [
  { code: "FLOUR-AP-50LB", name: "All-Purpose Flour 50 lb Bag", rate: 28 },
  { code: "OIL-EVOO-3L", name: "Extra Virgin Olive Oil 3 L Tin", rate: 42 },
  { code: "TOMATO-DICED-10", name: "Canned Diced Tomatoes #10 Case (6)", rate: 38 },
  { code: "RICE-LG-25LB", name: "Long Grain White Rice 25 lb Bag", rate: 24 },
  { code: "SUGAR-GRAN-25LB", name: "Granulated Sugar 25 lb Bag", rate: 21 },
  { code: "PASTA-PENNE-20LB", name: "Dry Penne Pasta 20 lb Case", rate: 27 },
  { code: "OIL-CANOLA-35LB", name: "Canola Frying Oil 35 lb Jug", rate: 36 },
  { code: "BEANS-BLACK-10", name: "Black Beans #10 Case (6)", rate: 33 },
];

export type SpendPattern =
  | { kind: "growing"; monthlyChange: number }
  | { kind: "declining"; monthlyChange: number }
  | { kind: "stable" }
  | { kind: "churned"; lastMonth: number };

export type SeedCustomer = {
  code: string;
  name: string;
  baseMonthlySpend: number;
  pattern: SpendPattern;
};

export const CUSTOMERS: readonly SeedCustomer[] = [
  { code: "BLUERIDGE", name: "Blue Ridge Kitchens", baseMonthlySpend: 2400, pattern: { kind: "growing", monthlyChange: 0.09 } },
  { code: "HARBORLANE", name: "Harbor Lane Bistro", baseMonthlySpend: 1800, pattern: { kind: "growing", monthlyChange: 0.1 } },
  { code: "GOLDENSPOON", name: "Golden Spoon Catering", baseMonthlySpend: 3200, pattern: { kind: "growing", monthlyChange: 0.07 } },
  { code: "PRAIRIEFORK", name: "Prairie Fork Restaurant Group", baseMonthlySpend: 4100, pattern: { kind: "growing", monthlyChange: 0.06 } },
  { code: "COPPERKETTLE", name: "Copper Kettle Diner", baseMonthlySpend: 3600, pattern: { kind: "declining", monthlyChange: -0.08 } },
  { code: "MAPLESTREET", name: "Maple Street Cafe", baseMonthlySpend: 2200, pattern: { kind: "declining", monthlyChange: -0.07 } },
  { code: "SUNSETGRILL", name: "Sunset Grill & Taphouse", baseMonthlySpend: 4400, pattern: { kind: "declining", monthlyChange: -0.06 } },
  { code: "RIVERBEND", name: "Riverbend Hospitality", baseMonthlySpend: 5200, pattern: { kind: "declining", monthlyChange: -0.09 } },
  { code: "ACME", name: "Acme Foods Inc.", baseMonthlySpend: 3800, pattern: { kind: "stable" } },
  { code: "LAKESIDE", name: "Lakeside Deli Co.", baseMonthlySpend: 1600, pattern: { kind: "stable" } },
  { code: "NORTHGATE", name: "Northgate School Cafeteria Services", baseMonthlySpend: 5600, pattern: { kind: "stable" } },
  { code: "REDWOOD", name: "Redwood Pizza Kitchen", baseMonthlySpend: 2700, pattern: { kind: "stable" } },
  { code: "UNIONSTATION", name: "Union Station Eatery", baseMonthlySpend: 2000, pattern: { kind: "stable" } },
  { code: "BAYVIEW", name: "Bayview Noodle House", baseMonthlySpend: 2500, pattern: { kind: "churned", lastMonth: 6 } },
  { code: "ELMOAK", name: "Elm & Oak Supper Club", baseMonthlySpend: 3000, pattern: { kind: "churned", lastMonth: 5 } },
];

const DRAFT_CUSTOMER_CODES = ["BLUERIDGE", "ACME", "SUNSETGRILL", "REDWOOD"] as const;

export type PlannedLine = { itemCode: string; qty: number; rate: number };

export type PlannedInvoice = {
  ref: string;
  customerCode: string;
  customerName: string;
  postingDate: string;
  docstatus: 0 | 1;
  lines: PlannedLine[];
  total: number;
};

export type SeedPlan = {
  items: readonly SeedItem[];
  customers: readonly SeedCustomer[];
  invoices: PlannedInvoice[];
};

export function buildSeedPlan(): SeedPlan {
  const rng = createRng(RANDOM_SEED);
  const invoices: PlannedInvoice[] = [];

  const buildLines = (target: number, lineCount: number): PlannedLine[] => {
    const items = rng.sample(ITEMS, lineCount);
    const weights = items.map(() => rng.between(0.5, 1.5));
    const weightSum = weights.reduce((sum, w) => sum + w, 0);
    return items.map((item, i) => ({
      itemCode: item.code,
      qty: Math.max(1, Math.round((target * (weights[i] as number)) / weightSum / item.rate)),
      rate: item.rate,
    }));
  };

  for (const customer of CUSTOMERS) {
    for (let month = 1; month <= MONTHS; month++) {
      const spend = monthlySpend(customer, month, rng.between(-1, 1));
      if (spend === 0) continue;

      const invoiceCount = rng.next() < 0.4 ? 2 : 1;
      const maxDay = month === MONTHS ? LAST_DAY_OF_FINAL_MONTH : 28;
      const days = rng.sample(range(1, maxDay), invoiceCount).sort((a, b) => a - b);

      days.forEach((day, i) => {
        const lines = buildLines(spend / invoiceCount, rng.int(1, 4));
        invoices.push({
          ref: `${SEED_PREFIX}-${customer.code}-${YEAR}-${pad(month)}-${i + 1}`,
          customerCode: customer.code,
          customerName: customer.name,
          postingDate: `${YEAR}-${pad(month)}-${pad(day)}`,
          docstatus: 1,
          lines,
          total: invoiceTotal(lines),
        });
      });
    }
  }

  DRAFT_CUSTOMER_CODES.forEach((code) => {
    const customer = CUSTOMERS.find((c) => c.code === code) as SeedCustomer;
    const lines = buildLines(customer.baseMonthlySpend / 2, rng.int(1, 3));
    invoices.push({
      ref: `${SEED_PREFIX}-${code}-${DRAFT_POSTING_DATE.slice(0, 7)}-D1`,
      customerCode: code,
      customerName: customer.name,
      postingDate: DRAFT_POSTING_DATE,
      docstatus: 0,
      lines,
      total: invoiceTotal(lines),
    });
  });

  return { items: ITEMS, customers: CUSTOMERS, invoices };
}

// noise is in [-1, 1]; stable customers get wider noise so they don't look flat.
function monthlySpend(customer: SeedCustomer, month: number, noise: number): number {
  const elapsed = month - 1;
  const { pattern, baseMonthlySpend: base } = customer;
  switch (pattern.kind) {
    case "growing":
    case "declining":
      return base * (1 + pattern.monthlyChange) ** elapsed * (1 + 0.06 * noise);
    case "stable":
      return base * (1 + 0.12 * noise);
    case "churned":
      return month > pattern.lastMonth ? 0 : base * (1 + 0.1 * noise);
  }
}

function invoiceTotal(lines: PlannedLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
