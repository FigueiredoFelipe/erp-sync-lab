import { describe, expect, it } from "@jest/globals";
import { buildCustomerIndex, CustomerMappingError, resolveCustomer } from "./resolve.ts";

const index = buildCustomerIndex(2, [
  { source: "erpnext", matchKey: "Acme Foods Inc.", canonicalId: "acme-foods" },
  { source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" },
  { source: "legacy_unit_b", matchKey: "Acme Co", canonicalId: "acme-co" },
]);

describe("resolveCustomer (BR05)", () => {
  it("resolves Source A by the exact ERPNext customer ID only", () => {
    expect(resolveCustomer(index, "erpnext", "Acme Foods Inc.")).toBe("acme-foods");
    expect(resolveCustomer(index, "erpnext", "acme foods inc")).toBeNull();
    expect(resolveCustomer(index, "erpnext", "ACME FOODS")).toBeNull();
  });

  it("resolves Source B through a normalized alias", () => {
    expect(resolveCustomer(index, "legacy_unit_b", "Acme  Foods")).toBe("acme-foods");
    expect(resolveCustomer(index, "legacy_unit_b", "acme co.")).toBe("acme-co");
    expect(resolveCustomer(index, "legacy_unit_b", "Acme Inc")).toBeNull();
    expect(resolveCustomer(index, "legacy_unit_b", "Acme Foods Inc.")).toBeNull();
  });

  it("returns null for a null customer", () => {
    expect(resolveCustomer(index, "erpnext", null)).toBeNull();
    expect(resolveCustomer(index, "legacy_unit_b", null)).toBeNull();
  });

  it("keeps the mapping version", () => {
    expect(index.mappingVersion).toBe(2);
  });
});

describe("buildCustomerIndex", () => {
  it("accepts two Unit B aliases that normalize equal when they point at the same customer", () => {
    const ok = buildCustomerIndex(1, [
      { source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" },
      { source: "legacy_unit_b", matchKey: "Acme Foods", canonicalId: "acme-foods" },
    ]);
    expect(ok.legacyUnitB.size).toBe(1);
  });

  it("fails closed when two Unit B aliases normalize equal but point at different customers", () => {
    expect(() =>
      buildCustomerIndex(1, [
        { source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" },
        { source: "legacy_unit_b", matchKey: "Acme, Foods", canonicalId: "other" },
      ]),
    ).toThrow(CustomerMappingError);
  });

  it("refuses an alias that normalizes to nothing, or a bad version", () => {
    expect(() => buildCustomerIndex(1, [{ source: "legacy_unit_b", matchKey: "...", canonicalId: "x" }])).toThrow(CustomerMappingError);
    expect(() => buildCustomerIndex(-1, [])).toThrow(CustomerMappingError);
  });
});
