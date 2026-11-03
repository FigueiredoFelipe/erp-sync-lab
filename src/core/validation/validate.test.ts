import { describe, expect, it } from "@jest/globals";
import type { CanonicalCandidate } from "../canonical.ts";
import { buildCustomerIndex } from "../customers/resolve.ts";
import { defaultValidationConfig, validate } from "./validate.ts";

// The mapping the tests resolve against: one Source A ID and two Unit B aliases.
const customers = buildCustomerIndex(3, [
  { source: "erpnext", matchKey: "CUST-0001", canonicalId: "cust-one" },
  { source: "legacy_unit_b", matchKey: "ACME CO", canonicalId: "acme-co" },
  { source: "legacy_unit_b", matchKey: "Redwood Pizza Kitchen", canonicalId: "redwood-pizza-kitchen" },
]);
const VALID = { kind: "valid", canonicalCustomerId: "cust-one" };

// A valid Source A invoice: two lines adding up to the net total.
function candidate(overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    source: "erpnext",
    sourceDocId: "ACC-SINV-2026-00001",
    sourceVersion: "1|2026-03-10 12:00:00.000000",
    rawRef: "raw/erpnext/ACC-SINV-2026-00001.json",
    sourceCustomer: "CUST-0001",
    invoiceDate: "2026-03-10",
    currency: "USD",
    isCreditNote: false,
    status: "final",
    netTotal: 150,
    lines: [
      { lineNo: 1, itemCode: "ITEM-1", description: null, qty: 1, unitPrice: 100, netAmount: 100 },
      { lineNo: 2, itemCode: "ITEM-2", description: null, qty: 2, unitPrice: 25, netAmount: 50 },
    ],
    parseIssues: [],
    ...overrides,
  };
}

// A valid Source B invoice for the "ACME CO" alias.
function legacy(overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return candidate({
    source: "legacy_unit_b",
    sourceDocId: "UB-26004",
    sourceVersion: "2026-10-16",
    rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
    sourceCustomer: "ACME CO",
    ...overrides,
  });
}

const run = (c: CanonicalCandidate) => validate(c, customers, defaultValidationConfig);
const invalid = (reasonCode: string) => ({ kind: "invalid", reasonCode });

describe("validate", () => {
  it("accepts a valid invoice", () => {
    expect(run(candidate())).toEqual(VALID);
  });

  it("uses the 2026 period by default", () => {
    expect(defaultValidationConfig).toEqual({ periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(validate(candidate({ invoiceDate: "2027-01-01" }), customers)).toEqual(invalid("INVALID_DATE"));
  });

  describe("BR01 cancelled", () => {
    it("returns cancelled before any check, even when invalid", () => {
      const c = candidate({ status: "cancelled", sourceCustomer: null, currency: "EUR", netTotal: 1, lines: [] });
      expect(run(c)).toEqual({ kind: "cancelled" });
    });
  });

  describe("BR03 required fields", () => {
    it.each([
      ["customer", { sourceCustomer: null }],
      ["blank customer", { sourceCustomer: "   " }],
      ["currency", { currency: null }],
      ["blank currency", { currency: " " }],
      ["net total", { netTotal: null }],
      ["lines", { lines: [] }],
      ["field flagged by the adapter", { parseIssues: ["MISSING_FIELD" as const] }],
      ["date flagged as missing by the adapter", { invoiceDate: null, parseIssues: ["MISSING_FIELD" as const] }],
    ])("rejects a missing %s", (_name, overrides) => {
      expect(run(candidate(overrides))).toEqual(invalid("MISSING_FIELD"));
    });
  });

  describe("BR03 dates", () => {
    it("rejects a date flagged by the adapter", () => {
      expect(run(candidate({ parseIssues: ["INVALID_DATE"] }))).toEqual(invalid("INVALID_DATE"));
    });

    it("rejects a date the adapter nulled and flagged as malformed", () => {
      expect(run(candidate({ invoiceDate: null, parseIssues: ["INVALID_DATE"] }))).toEqual(invalid("INVALID_DATE"));
    });

    it("treats a null date without an INVALID_DATE flag as missing", () => {
      expect(run(candidate({ invoiceDate: null }))).toEqual(invalid("MISSING_FIELD"));
    });

    it.each(["2026-02-30", "02/14/2026", "2026-2-14", "2026-02-14T00:00:00Z", "2026-13-01", ""])(
      "rejects the badly formatted date %p",
      (invoiceDate) => {
        expect(run(candidate({ invoiceDate }))).toEqual(invalid("INVALID_DATE"));
      },
    );

    it.each(["2025-12-31", "2027-01-01"])("rejects %s, outside the period", (invoiceDate) => {
      expect(run(candidate({ invoiceDate }))).toEqual(invalid("INVALID_DATE"));
    });

    it.each(["2026-01-01", "2026-12-31"])("accepts %s, on the inclusive boundary", (invoiceDate) => {
      expect(run(candidate({ invoiceDate }))).toEqual(VALID);
    });

    it("uses the configured period", () => {
      const config = { periodStart: "2027-01-01", periodEnd: "2027-12-31" };
      expect(validate(candidate({ invoiceDate: "2027-06-01" }), customers, config)).toEqual(VALID);
      expect(validate(candidate(), customers, config)).toEqual(invalid("INVALID_DATE"));
    });
  });

  describe("BR04 currency", () => {
    it.each(["EUR", "usd"])("rejects %s", (currency) => {
      expect(run(candidate({ currency }))).toEqual(invalid("UNSUPPORTED_CURRENCY"));
    });
  });

  describe("BR02 totals", () => {
    it("accepts a total exactly 0.01 off", () => {
      expect(run(candidate({ netTotal: 150.01 }))).toEqual(VALID);
      expect(run(candidate({ netTotal: 149.99 }))).toEqual(VALID);
    });

    it("rejects a total 0.02 off", () => {
      expect(run(candidate({ netTotal: 150.02 }))).toEqual(invalid("TOTAL_MISMATCH"));
      expect(run(candidate({ netTotal: 149.98 }))).toEqual(invalid("TOTAL_MISMATCH"));
    });

    it("handles float sums like 0.1 + 0.2", () => {
      const lines = [
        { lineNo: 1, itemCode: null, description: null, qty: 1, unitPrice: 0.1, netAmount: 0.1 },
        { lineNo: 2, itemCode: null, description: null, qty: 1, unitPrice: 0.2, netAmount: 0.2 },
      ];
      expect(run(candidate({ netTotal: 0.3, lines }))).toEqual(VALID);
      expect(run(candidate({ netTotal: 0.32, lines }))).toEqual(invalid("TOTAL_MISMATCH"));
    });
  });

  describe("BR06 conflicting rows", () => {
    it("rejects an invoice the Source B adapter flagged as CONFLICTING_DUPLICATE", () => {
      expect(run(legacy({ parseIssues: ["CONFLICTING_DUPLICATE"] }))).toEqual(invalid("CONFLICTING_DUPLICATE"));
    });
  });

  describe("BR05 customer resolution", () => {
    it("resolves Source A by the exact ERPNext customer ID", () => {
      expect(run(candidate({ sourceCustomer: "CUST-0001" }))).toEqual(VALID);
    });

    it.each(["cust-0001", "CUST-0001 ", "CUST 0001", "Acme Co"])("rejects Source A customer %p, not an exact ID in the mapping", (sourceCustomer) => {
      expect(run(candidate({ sourceCustomer }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });

    it("resolves a Source B name that normalizes to a listed alias", () => {
      expect(run(legacy({ sourceCustomer: "Acme, Co." }))).toEqual({ kind: "valid", canonicalCustomerId: "acme-co" });
      expect(run(legacy({ sourceCustomer: "  acme   CO " }))).toEqual({ kind: "valid", canonicalCustomerId: "acme-co" });
    });

    it("keeps legal suffixes: Acme Inc is not Acme Co", () => {
      expect(run(legacy({ sourceCustomer: "Acme Inc" }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
      expect(run(legacy({ sourceCustomer: "Acme" }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });

    it("REDWOOD  PIZZA KITCHEN resolves only because the Unit B mapping lists the alias", () => {
      expect(run(legacy({ sourceCustomer: "REDWOOD  PIZZA KITCHEN" }))).toEqual({ kind: "valid", canonicalCustomerId: "redwood-pizza-kitchen" });
      const erpOnly = buildCustomerIndex(1, [{ source: "erpnext", matchKey: "Redwood Pizza Kitchen", canonicalId: "redwood-pizza-kitchen" }]);
      expect(validate(legacy({ sourceCustomer: "REDWOOD  PIZZA KITCHEN" }), erpOnly)).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });

    it("never resolves a Source A customer through a Unit B alias, or the reverse", () => {
      expect(run(candidate({ sourceCustomer: "ACME CO" }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
      expect(run(legacy({ sourceCustomer: "CUST-0001" }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });

    it("rejects a customer that normalizes to nothing", () => {
      expect(run(legacy({ sourceCustomer: "..." }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });
  });

  describe("one reason code, in the spec's order", () => {
    it("blank customer + bad date gives MISSING_FIELD", () => {
      expect(run(candidate({ sourceCustomer: "", invoiceDate: "2026-02-30" }))).toEqual(invalid("MISSING_FIELD"));
    });

    it("bad date + EUR gives INVALID_DATE", () => {
      expect(run(candidate({ invoiceDate: "02/14/2026", currency: "EUR" }))).toEqual(invalid("INVALID_DATE"));
    });

    it("EUR + total mismatch gives UNSUPPORTED_CURRENCY", () => {
      expect(run(candidate({ currency: "EUR", netTotal: 999 }))).toEqual(invalid("UNSUPPORTED_CURRENCY"));
    });

    it("EUR + conflicting rows gives UNSUPPORTED_CURRENCY", () => {
      expect(run(legacy({ currency: "EUR", parseIssues: ["CONFLICTING_DUPLICATE"] }))).toEqual(invalid("UNSUPPORTED_CURRENCY"));
    });

    it("bad date + conflicting rows gives INVALID_DATE", () => {
      expect(run(legacy({ parseIssues: ["INVALID_DATE", "CONFLICTING_DUPLICATE"] }))).toEqual(invalid("INVALID_DATE"));
    });

    it("conflicting rows + total mismatch gives CONFLICTING_DUPLICATE (UB-26005)", () => {
      expect(run(legacy({ netTotal: 999, parseIssues: ["CONFLICTING_DUPLICATE"] }))).toEqual(invalid("CONFLICTING_DUPLICATE"));
    });

    it("total mismatch + unknown customer gives TOTAL_MISMATCH", () => {
      expect(run(legacy({ netTotal: 999, sourceCustomer: "Nobody LLC" }))).toEqual(invalid("TOTAL_MISMATCH"));
    });

    it("blank customer gives MISSING_FIELD, not UNKNOWN_CUSTOMER (UB-26023)", () => {
      expect(run(legacy({ sourceCustomer: null }))).toEqual(invalid("MISSING_FIELD"));
    });

    it("a Source B row without INV_NO gives MISSING_FIELD, whatever else is wrong (Q8)", () => {
      const row = legacy({ sourceDocId: "unit_b_export_2026-10-16.csv#row7", sourceCustomer: "Nobody", currency: "EUR", parseIssues: ["MISSING_FIELD"] });
      expect(run(row)).toEqual(invalid("MISSING_FIELD"));
    });

    it("unknown customer alone gives UNKNOWN_CUSTOMER", () => {
      expect(run(candidate({ sourceCustomer: "CUST-9999" }))).toEqual(invalid("UNKNOWN_CUSTOMER"));
    });
  });

  // BR07 known limitation: the sign is not validated, only that the lines add up.
  it("accepts a credit note with negative amounts that add up", () => {
    const c = candidate({
      isCreditNote: true,
      netTotal: -150,
      lines: [
        { lineNo: 1, itemCode: "ITEM-1", description: null, qty: -1, unitPrice: 100, netAmount: -100 },
        { lineNo: 2, itemCode: "ITEM-2", description: null, qty: -2, unitPrice: 25, netAmount: -50 },
      ],
    });
    expect(run(c)).toEqual(VALID);
  });
});
