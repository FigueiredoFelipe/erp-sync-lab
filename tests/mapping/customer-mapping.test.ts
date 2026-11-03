import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCustomerName } from "../../src/core/customers/normalize.ts";
import { buildCustomerIndex, resolveCustomer } from "../../src/core/customers/resolve.ts";
import { CUSTOMERS } from "../../scripts/seed/data.ts";
import { aliasesOf, shippedMapping } from "./mapping-file.ts";

// T8: the shipped mapping lists every canonical customer (R05, BR05) and resolves every customer name both
// sources use, with no ambiguity after normalization.

// "| As written in the CSV | Canonical customer | In | ..." rows of data/legacy_unit_b.README.md.
function unitBTable(): { asWritten: string; canonical: string; only: boolean }[] {
  const readme = readFileSync(join(__dirname, "..", "..", "data", "legacy_unit_b.README.md"), "utf8");
  const section = readme.split("## Customers (BR05)")[1]!;
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| As written") && !line.startsWith("|---"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map((cells) => ({ asWritten: cells[1]!, canonical: cells[2]!, only: cells[3] === "Unit B only" }));
}

describe("shipped customer mapping", () => {
  const mapping = shippedMapping();
  const index = buildCustomerIndex(1, aliasesOf(mapping));
  const displayName = (id: string | null) => mapping.find((e) => e.canonical_id === id)?.display_name ?? null;

  it("has no Unit B alias collision after normalization, and no ERPNext ID listed twice (the consumer would stall)", () => {
    const owners = new Map<string, Set<string>>();
    for (const e of mapping) {
      for (const alias of e.legacy_unit_b) {
        const key = `legacy_unit_b:${normalizeCustomerName(alias)}`;
        owners.set(key, (owners.get(key) ?? new Set()).add(e.canonical_id));
      }
      for (const id of e.erpnext) {
        const key = `erpnext:${id}`;
        owners.set(key, (owners.get(key) ?? new Set()).add(e.canonical_id));
      }
    }
    const collisions = [...owners].filter(([, ids]) => ids.size > 1).map(([key, ids]) => `${key} -> ${[...ids].join(", ")}`);
    expect(collisions).toEqual([]);
    for (const e of mapping) for (const alias of e.legacy_unit_b) expect(normalizeCustomerName(alias)).not.toBe("");
  });

  it("lists 18 canonical customers with unique slugs", () => {
    expect(mapping).toHaveLength(18);
    expect(new Set(mapping.map((e) => e.canonical_id)).size).toBe(18);
    for (const e of mapping) expect(e.canonical_id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("resolves each of the 15 ERPNext customers by its exact ID (the customer name)", () => {
    expect(CUSTOMERS).toHaveLength(15);
    for (const c of CUSTOMERS) expect({ c: c.name, to: displayName(resolveCustomer(index, "erpnext", c.name)) }).toEqual({ c: c.name, to: c.name });
  });

  it("resolves every Unit B name of the README to its canonical customer", () => {
    const rows = unitBTable();
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect({ name: row.asWritten, to: displayName(resolveCustomer(index, "legacy_unit_b", row.asWritten)) }).toEqual({
        name: row.asWritten,
        to: row.canonical,
      });
    }
  });

  it("has exactly 3 Unit B only customers, with no ERPNext alias", () => {
    const unitBOnly = unitBTable().filter((r) => r.only).map((r) => r.canonical).sort();
    expect(unitBOnly).toEqual(["Cedar Valley Bakery, Inc.", "Old Mill Tavern", "Pinecrest Senior Living"]);
    expect(mapping.filter((e) => e.erpnext.length === 0).map((e) => e.display_name).sort()).toEqual(unitBOnly);
  });

  it("maps ACME FOODS to Acme Foods Inc. (acme-foods)", () => {
    expect(resolveCustomer(index, "legacy_unit_b", "ACME FOODS")).toBe("acme-foods");
    expect(displayName("acme-foods")).toBe("Acme Foods Inc.");
  });
});
