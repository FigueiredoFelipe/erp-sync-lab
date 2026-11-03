import { describe, expect, it } from "@jest/globals";
import { normalizeCustomerName } from "./normalize.ts";

describe("normalizeCustomerName (BR05)", () => {
  it.each([
    ["ACME FOODS", "acme foods"],
    ["REDWOOD  PIZZA KITCHEN", "redwood pizza kitchen"],
    ["Redwood Pizza Kitchen", "redwood pizza kitchen"],
    ["Cedar Valley Bakery, Inc.", "cedar valley bakery inc"],
    ["Harbor Ln. Bistro", "harbor ln bistro"],
    ["Sunset Grill & Taphouse", "sunset grill taphouse"],
    ["  Old\tMill \n Tavern  ", "old mill tavern"],
    ["Ｏｌｄ Ｍｉｌｌ", "old mill"],
  ])("%p -> %p", (input, expected) => {
    expect(normalizeCustomerName(input)).toBe(expected);
  });

  it("keeps legal suffixes, so Acme Co and Acme Inc stay different", () => {
    expect(normalizeCustomerName("Acme Co")).toBe("acme co");
    expect(normalizeCustomerName("Acme Inc")).toBe("acme inc");
    expect(normalizeCustomerName("Acme Co")).not.toBe(normalizeCustomerName("Acme Inc"));
    expect(normalizeCustomerName("Blue Ridge Kitchens LLC")).toBe("blue ridge kitchens llc");
    expect(normalizeCustomerName("Blue Ridge Kitchens LLC")).not.toBe(normalizeCustomerName("Blue Ridge Kitchens"));
  });

  it("does not abbreviate or expand words (Ln is not Lane, AND is not &)", () => {
    expect(normalizeCustomerName("Harbor Ln. Bistro")).not.toBe(normalizeCustomerName("Harbor Lane Bistro"));
    expect(normalizeCustomerName("SUNSET GRILL AND TAPHOUSE")).not.toBe(normalizeCustomerName("Sunset Grill & Taphouse"));
  });

  it("reduces punctuation-only names to an empty key", () => {
    expect(normalizeCustomerName(" .,- ")).toBe("");
  });
});
