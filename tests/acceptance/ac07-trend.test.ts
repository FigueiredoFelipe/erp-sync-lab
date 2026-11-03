import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildUnitBExports, invoiceCents, isValid, type UnitBInvoice } from "../../scripts/legacy/unit-b-plan.ts";
import { trend } from "../../src/core/trend/trend.ts";

// AC07: with the as-of date fixed at 2026-10-16, every customer's trend matches the table in
// scripts/seed/README.md. Inputs come from the same plans the seed and the Unit B generator use
// (buildSeedPlan via buildUnitBExports), not from a copy: the seeded ERPNext invoices plus the valid
// invoices of the main Unit B export, mapped to their canonical customers.
const AS_OF = "2026-10-16";

type Expected = { customer: string; prev3: string; last3: string; label: string };

function expectedTable(): Expected[] {
  const readme = readFileSync(join(__dirname, "..", "..", "scripts", "seed", "README.md"), "utf8");
  return readme
    .split("\n")
    .filter((line) => /^\| .+ \| \*\*\w+\*\* \|$/.test(line))
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      return { customer: cells[0]!, prev3: cells[2]!, last3: cells[3]!, label: cells[5]!.replace(/\*/g, "") };
    });
}

// Customer name -> "YYYY-MM" -> cents, both sources combined (BR08 uses both).
function combinedHistory(unitB: UnitBInvoice[]): Map<string, Map<string, number>> {
  const { erpMonthlyCents } = buildUnitBExports();
  const combined = new Map<string, Map<string, number>>();
  const add = (customer: string, month: number, cents: number) => {
    const months = combined.get(customer) ?? new Map<string, number>();
    const key = `2026-${String(month).padStart(2, "0")}`;
    months.set(key, (months.get(key) ?? 0) + cents);
    combined.set(customer, months);
  };
  for (const [customer, monthly] of erpMonthlyCents) monthly.forEach((cents, i) => add(customer, i + 1, cents));
  for (const invoice of unitB.filter(isValid)) add(invoice.customer.canonical, invoice.month, invoiceCents(invoice));
  return combined;
}

const usd = (cents: number) => `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

describe("AC07: expected trends at as-of 2026-10-16", () => {
  const expected = expectedTable();

  it("reads the 18 customers of the expected table", () => {
    expect(expected).toHaveLength(18);
  });

  it.each(expected.map((row) => [row.customer, row] as const))("%s", (customer, row) => {
    const history = combinedHistory(buildUnitBExports().invoices).get(customer) ?? new Map<string, number>();
    const result = trend(history, AS_OF);
    expect({ prev3: usd(result.prev3Cents), last3: usd(result.last3Cents), label: result.label }).toEqual({
      prev3: row.prev3,
      last3: row.last3,
      label: row.label,
    });
  });

  it("ingesting the newer 2026-10-17 snapshot changes no expected trend", () => {
    const newer = combinedHistory(buildUnitBExports().newerSnapshot);
    for (const row of expected) {
      expect([row.customer, trend(newer.get(row.customer) ?? new Map(), AS_OF).label]).toEqual([row.customer, row.label]);
    }
  });
});
