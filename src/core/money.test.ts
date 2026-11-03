import { describe, expect, it } from "@jest/globals";
import { centsToDecimal, formatUsdCents, toCents } from "./money.ts";

describe("toCents", () => {
  it("reads numbers and strings exactly", () => {
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents("461664.00")).toBe(46166400);
    expect(toCents("12.5")).toBe(1250);
    expect(toCents("7")).toBe(700);
    expect(toCents("-0.05")).toBe(-5);
    expect(toCents(-12.34)).toBe(-1234);
  });

  it("rejects amounts with more than 2 decimals or garbage", () => {
    expect(() => toCents("1.234")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });
});

describe("centsToDecimal", () => {
  it("renders 2 decimals", () => {
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(-5)).toBe("-0.05");
  });
});

describe("formatUsdCents", () => {
  it("formats USD with grouping and 2 decimals", () => {
    expect(formatUsdCents(46166400)).toBe("$461,664.00");
    expect(formatUsdCents(99)).toBe("$0.99");
    expect(formatUsdCents(-123456789)).toBe("-$1,234,567.89");
  });
});
