import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import type { CanonicalCandidate } from "../../canonical.ts";
import { validate } from "../../validation/validate.ts";
import { buildCustomerIndex } from "../../customers/resolve.ts";
import { aliasesOf, shippedMapping } from "../../../../tests/mapping/mapping-file.ts";
import { exportDateOf, HEADER, MAX_ROWS, parseFile, type ParseResult } from "./adapter.ts";

// T11: the Source B adapter against the three files in data/ and the outcomes in data/legacy_unit_b.README.md.

const DATA = join(__dirname, "..", "..", "..", "..", "data");
const MAIN = "unit_b_export_2026-10-16.csv";
const NEWER = "unit_b_export_2026-10-17.csv";
const OLDER = "unit_b_export_2026-10-15.csv";
const HEADER_LINE = HEADER.join(",");

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(DATA, name)));
}

function parsed(result: ParseResult): Extract<ParseResult, { kind: "parsed" }> {
  if (result.kind !== "parsed") throw new Error(`expected parsed, got rejected: ${result.reason}`);
  return result;
}

function parseText(text: string, name = "unit_b_export_2026-10-20.csv"): ParseResult {
  return parseFile(text, name, parse);
}

function byId(candidates: CanonicalCandidate[]): Map<string, CanonicalCandidate> {
  return new Map(candidates.map((c) => [c.sourceDocId, c]));
}

// The verdict the consumer reaches: validate() with the shipped customer mapping, in the spec's order
// (BR03 -> BR04 -> BR06 -> BR02 -> BR05).
const customers = buildCustomerIndex(1, aliasesOf(shippedMapping()));

function verdict(c: CanonicalCandidate): string {
  const v = validate(c, customers);
  return v.kind === "invalid" ? v.reasonCode : v.kind;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

describe("exportDateOf", () => {
  it("takes the export date from the file name", () => {
    expect(exportDateOf(MAIN)).toBe("2026-10-16");
    expect(exportDateOf(`uploads/${MAIN}`)).toBe("2026-10-16");
  });

  it.each(["unit_b_export_2026-02-30.csv", "unit_b_export_20261016.csv", "export_2026-10-16.csv", "unit_b_export_2026-10-16.CSV", "unit_b_export_2026-10-16.csv.bak"])(
    "rejects %s",
    (name) => {
      expect(exportDateOf(name)).toBeNull();
    },
  );
});

describe("parseFile: main export (2026-10-16)", () => {
  const result = parsed(parseFile(load(MAIN), MAIN, parse));
  const candidates = byId(result.candidates);

  it("reads every row and groups them into 85 invoices", () => {
    expect(result.exportDate).toBe("2026-10-16");
    expect(result.rowCount).toBe(183);
    expect(result.candidates).toHaveLength(85);
  });

  it("builds the canonical candidate (UB-26001)", () => {
    expect(candidates.get("UB-26001")).toEqual({
      source: "legacy_unit_b",
      sourceDocId: "UB-26001",
      sourceVersion: "2026-10-16",
      rawRef: `legacy-uploads/${MAIN}`,
      sourceCustomer: "Lakeside Deli Company",
      invoiceDate: "2026-01-07",
      currency: "USD",
      isCreditNote: false,
      status: "final",
      netTotal: 882,
      lines: [{ lineNo: 1, itemCode: null, description: "OLIVE OIL EV 3L", qty: 20, unitPrice: 44.1, netAmount: 882 }],
      parseIssues: [],
    });
  });

  it("keeps quoted names with commas as written", () => {
    expect(candidates.get("UB-26002")?.sourceCustomer).toBe("Cedar Valley Bakery, Inc.");
    expect(candidates.get("UB-26084")?.sourceCustomer).toBe("REDWOOD  PIZZA KITCHEN");
  });

  it.each([
    ["UB-26004", "TOTAL_MISMATCH"],
    ["UB-26005", "CONFLICTING_DUPLICATE"],
    ["UB-26010", "INVALID_DATE"],
    ["UB-26016", "TOTAL_MISMATCH"],
    ["UB-26022", "valid"],
    ["UB-26023", "MISSING_FIELD"],
    ["UB-26077", "TOTAL_MISMATCH"],
    ["UB-26084", "UNSUPPORTED_CURRENCY"],
    ["UB-26085", "valid"],
  ])("planted case %s -> %s", (id, expected) => {
    const c = candidates.get(id);
    expect(c).toBeDefined();
    expect(verdict(c as CanonicalCandidate)).toBe(expected);
  });

  it("flags the conflicting INV_TOTAL of UB-26005 and keeps all its rows", () => {
    const c = candidates.get("UB-26005") as CanonicalCandidate;
    expect(c.parseIssues).toEqual(["CONFLICTING_DUPLICATE"]);
    expect(c.lines).toHaveLength(3);
  });

  it("nulls the impossible date of UB-26010 and flags INVALID_DATE", () => {
    const c = candidates.get("UB-26010") as CanonicalCandidate;
    expect(c.invoiceDate).toBeNull();
    expect(c.parseIssues).toEqual(["INVALID_DATE"]);
  });

  it("UB-26023: blank CUST_NAME becomes null", () => {
    expect(candidates.get("UB-26023")?.sourceCustomer).toBeNull();
  });

  it("AC19: UB-26022 drops the export duplicate and counts it once", () => {
    const c = candidates.get("UB-26022") as CanonicalCandidate;
    expect(c.lines.map((l) => [l.lineNo, l.description, l.netAmount])).toEqual([
      [1, "BEANS BLACK #10 CS", 583.2],
      [2, "FLOUR AP 50LB", 417.75],
    ]);
    expect(c.netTotal).toBe(1000.95);
    expect(c.parseIssues).toEqual([]);
  });

  it("AC19: UB-26085 keeps both identical rows because INV_TOTAL needs them", () => {
    const c = candidates.get("UB-26085") as CanonicalCandidate;
    expect(c.lines.map((l) => l.netAmount)).toEqual([278.5, 278.5, 554.25]);
    expect(c.lines.reduce((s, l) => s + cents(l.netAmount), 0)).toBe(111125);
  });

  it("has 78 valid invoices totalling USD 109915.83", () => {
    const valid = result.candidates.filter((c) => verdict(c) === "valid");
    expect(valid).toHaveLength(78);
    expect(valid.reduce((s, c) => s + cents(c.netTotal as number), 0)).toBe(10_991_583);
  });

  it("matches the per-customer Unit B totals of the README (AC18 table, after 10-16)", () => {
    const totals = new Map<string, [number, number]>();
    for (const c of result.candidates.filter((x) => verdict(x) === "valid")) {
      const [n, t] = totals.get(c.sourceCustomer as string) ?? [0, 0];
      totals.set(c.sourceCustomer as string, [n + 1, t + cents(c.netTotal as number)]);
    }
    expect(Object.fromEntries(totals)).toEqual({
      "ACME FOODS": [9, 1_398_503],
      "Blue Ridge Kitchens LLC": [10, 1_247_295],
      "Harbor Ln. Bistro": [9, 1_209_495],
      "SUNSET GRILL AND TAPHOUSE": [9, 909_706],
      "Lakeside Deli Company": [9, 901_402],
      "REDWOOD  PIZZA KITCHEN": [9, 1_068_235],
      "Cedar Valley Bakery, Inc.": [9, 1_629_898],
      "Old Mill Tavern": [10, 1_747_171],
      "Pinecrest Senior Living": [4, 879_878],
    });
  });

  it("no row is missing INV_NO in the sample", () => {
    expect(result.candidates.some((c) => c.sourceDocId.includes("#row"))).toBe(false);
  });
});

describe("parseFile: the snapshot sequence files", () => {
  it("10-17 is the main export without UB-26001 and UB-26010", () => {
    const main = parsed(parseFile(load(MAIN), MAIN, parse));
    const newer = parsed(parseFile(load(NEWER), NEWER, parse));
    expect(newer.exportDate).toBe("2026-10-17");
    expect(newer.rowCount).toBe(180);
    expect(newer.candidates).toHaveLength(83);
    const newerIds = new Set(newer.candidates.map((c) => c.sourceDocId));
    expect(main.candidates.map((c) => c.sourceDocId).filter((id) => !newerIds.has(id))).toEqual(["UB-26001", "UB-26010"]);
    expect(newer.candidates.every((c) => c.sourceVersion === "2026-10-17")).toBe(true);
  });

  it("10-15 lacks the three invoices dated 10/15/2026", () => {
    const main = parsed(parseFile(load(MAIN), MAIN, parse));
    const older = parsed(parseFile(load(OLDER), OLDER, parse));
    expect(older.rowCount).toBe(174);
    expect(older.candidates).toHaveLength(82);
    const olderIds = new Set(older.candidates.map((c) => c.sourceDocId));
    expect(main.candidates.map((c) => c.sourceDocId).filter((id) => !olderIds.has(id))).toEqual(["UB-26083", "UB-26084", "UB-26085"]);
  });
});

describe("parseFile: whole-file rejection (EC07)", () => {
  it("rejects a file name without a valid export date", () => {
    expect(parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,1.00,1.00\n`, "export.csv")).toEqual({
      kind: "rejected",
      reason: "file name must be unit_b_export_YYYY-MM-DD.csv with a real date",
    });
  });

  it("rejects an empty file", () => {
    expect(parseText("")).toEqual({ kind: "rejected", reason: "file is empty" });
  });

  it("rejects a header-only file", () => {
    expect(parseText(`${HEADER_LINE}\n`)).toEqual({ kind: "rejected", reason: "file has no data rows" });
  });

  it.each([
    ["a missing column", "INV_NO,CUST_NAME,INV_DATE,CURRENCY,LINE_ITEM,QTY,UNIT_PRICE"],
    ["a renamed column", "INV_NO,CUSTOMER,INV_DATE,CURRENCY,LINE_ITEM,QTY,UNIT_PRICE,INV_TOTAL"],
    ["reordered columns", "CUST_NAME,INV_NO,INV_DATE,CURRENCY,LINE_ITEM,QTY,UNIT_PRICE,INV_TOTAL"],
    ["lowercase", HEADER_LINE.toLowerCase()],
    ["an extra column", `${HEADER_LINE},NOTES`],
  ])("rejects a header with %s", (_label, header) => {
    const row = new Array(header.split(",").length).fill("x").join(",");
    const result = parseText(`${header}\n${row}\n`);
    expect(result).toEqual({ kind: "rejected", reason: `header must be exactly ${HEADER_LINE}` });
  });

  it("rejects more than 5,000 data rows and accepts exactly 5,000", () => {
    const row = "UB-1,A,01/02/2026,USD,X,1,1.00,5000.00";
    const ok = parseText(`${HEADER_LINE}\n${`${row}\n`.repeat(MAX_ROWS)}`);
    expect(ok.kind).toBe("parsed");
    expect(parseText(`${HEADER_LINE}\n${`${row}\n`.repeat(MAX_ROWS + 1)}`)).toEqual({
      kind: "rejected",
      reason: "file has 5001 data rows, more than 5000",
    });
  });

  it("rejects a row with the wrong number of columns", () => {
    const result = parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,1.00\n`);
    expect(result.kind).toBe("rejected");
    expect((result as { reason: string }).reason).toMatch(/^malformed CSV: /);
  });

  it("rejects an unclosed quote", () => {
    const result = parseText(`${HEADER_LINE}\nUB-1,"A,01/02/2026,USD,X,1,1.00,1.00\n`);
    expect(result.kind).toBe("rejected");
  });

  it("rejects bytes that aren't UTF-8", () => {
    const bytes = new Uint8Array([...new TextEncoder().encode(`${HEADER_LINE}\nUB-1,`), 0xff, 0xfe, ...new TextEncoder().encode(",01/02/2026,USD,X,1,1.00,1.00\n")]);
    expect(parseFile(bytes, "unit_b_export_2026-10-20.csv", parse)).toEqual({ kind: "rejected", reason: "file is not valid UTF-8" });
  });

  it("accepts a UTF-8 BOM, CRLF line endings and blank lines", () => {
    const result = parsed(parseText(`﻿${HEADER_LINE}\r\nUB-1,A,01/02/2026,USD,X,2,1.50,3.00\r\n\r\n`));
    expect(result.rowCount).toBe(1);
    expect(result.candidates[0]?.invoiceDate).toBe("2026-01-02");
  });
});

describe("parseFile: rows and invoices", () => {
  it("Q8: a row without INV_NO is its own record, keyed by object name and data row, with MISSING_FIELD", () => {
    const result = parsed(
      parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,1.00,1.00\n,B,01/03/2026,USD,Y,2,2.00,4.00\n ,C,01/04/2026,USD,Z,1,3.00,3.00\n`),
    );
    expect(result.candidates.map((c) => [c.sourceDocId, c.parseIssues])).toEqual([
      ["UB-1", []],
      ["unit_b_export_2026-10-20.csv#row2", ["MISSING_FIELD"]],
      ["unit_b_export_2026-10-20.csv#row3", ["MISSING_FIELD"]],
    ]);
    expect(verdict(result.candidates[1] as CanonicalCandidate)).toBe("MISSING_FIELD");
    expect(result.candidates[1]?.sourceCustomer).toBe("B");
  });

  it("groups rows of one INV_NO even when they aren't adjacent, in file order", () => {
    const result = parsed(
      parseText(`${HEADER_LINE}\nUB-2,A,01/02/2026,USD,X,1,1.00,3.00\nUB-1,B,01/02/2026,USD,Y,1,5.00,5.00\nUB-2,A,01/02/2026,USD,Z,1,2.00,3.00\n`),
    );
    expect(result.candidates.map((c) => [c.sourceDocId, c.lines.map((l) => l.description)])).toEqual([
      ["UB-2", ["X", "Z"]],
      ["UB-1", ["Y"]],
    ]);
  });

  it.each([
    ["CUST_NAME", "UB-1,A,01/02/2026,USD,X,1,1.00,3.00\nUB-1,B,01/02/2026,USD,Y,1,2.00,3.00"],
    ["INV_DATE", "UB-1,A,01/02/2026,USD,X,1,1.00,3.00\nUB-1,A,01/03/2026,USD,Y,1,2.00,3.00"],
    ["CURRENCY", "UB-1,A,01/02/2026,USD,X,1,1.00,3.00\nUB-1,A,01/02/2026,EUR,Y,1,2.00,3.00"],
    ["INV_TOTAL", "UB-1,A,01/02/2026,USD,X,1,1.00,3.00\nUB-1,A,01/02/2026,USD,Y,1,2.00,3.01"],
  ])("BR06: rows that disagree on %s -> CONFLICTING_DUPLICATE", (_column, rows) => {
    const result = parsed(parseText(`${HEADER_LINE}\n${rows}\n`));
    expect(result.candidates[0]?.parseIssues).toContain("CONFLICTING_DUPLICATE");
  });

  it("BR06: amounts written differently but equal don't conflict", () => {
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,1.00,3\nUB-1,A,01/02/2026,USD,Y,1,2.00,3.00\n`));
    expect(result.candidates[0]?.parseIssues).toEqual([]);
  });

  it("BR06: identical rows matching neither reading keep every row, so BR02 decides", () => {
    // Once: 10.00, both: 15.00, INV_TOTAL 12.00.
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,5.00,12.00\nUB-1,A,01/02/2026,USD,X,1,5.00,12.00\nUB-1,A,01/02/2026,USD,Y,1,5.00,12.00\n`));
    const c = result.candidates[0] as CanonicalCandidate;
    expect(c.lines).toHaveLength(3);
    expect(verdict(c)).toBe("TOTAL_MISMATCH");
  });

  it("BR06: arbitration uses BR02's one-cent tolerance", () => {
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,1,5.00,10.01\nUB-1,A,01/02/2026,USD,X,1,5.00,10.01\nUB-1,A,01/02/2026,USD,Y,1,5.00,10.01\n`));
    expect(result.candidates[0]?.lines).toHaveLength(2);
  });

  it("BR06: a 2-cent gap is outside the tolerance, so no reading wins: every row is kept and BR02 decides", () => {
    // Once: 10.00 (2 cents off 10.02), both: 15.00. A wider tolerance would wrongly drop the repeat.
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,ACME FOODS,01/02/2026,USD,X,1,5.00,10.02\nUB-1,ACME FOODS,01/02/2026,USD,X,1,5.00,10.02\nUB-1,ACME FOODS,01/02/2026,USD,Y,1,5.00,10.02\n`));
    const c = result.candidates[0] as CanonicalCandidate;
    expect(c.lines).toHaveLength(3);
    expect(c.parseIssues).toEqual([]);
    expect(verdict(c)).toBe("TOTAL_MISMATCH");
  });

  it("BR06 before BR02 on real data: UB-26004 with one row correcting INV_TOTAL is CONFLICTING_DUPLICATE, not TOTAL_MISMATCH", () => {
    const text = new TextDecoder().decode(load(MAIN)).replace(
      "UB-26004,ACME FOODS,01/15/2026,USD,TOMATO DICED #10 CS,20,36.95,1452.40",
      "UB-26004,ACME FOODS,01/15/2026,USD,TOMATO DICED #10 CS,20,36.95,1407.40",
    );
    const c = byId(parsed(parseFile(text, MAIN, parse)).candidates).get("UB-26004") as CanonicalCandidate;
    // The first row's total (1452.40) also mismatches the line sum (1407.40): BR06 must still win.
    expect([c.netTotal, c.parseIssues]).toEqual([1452.4, ["CONFLICTING_DUPLICATE"]]);
    expect(verdict(c)).toBe("CONFLICTING_DUPLICATE");
  });

  it("BR03: dates must be strictly MM/DD/YYYY and real", () => {
    const rows = ["2026-01-02", "1/2/2026", "13/01/2026", "02/29/2026", "01/02/26"].map((d, i) => `UB-${i},A,${d},USD,X,1,1.00,1.00`);
    const result = parsed(parseText(`${HEADER_LINE}\n${rows.join("\n")}\nUB-9,A,02/28/2026,USD,X,1,1.00,1.00\n`));
    expect(result.candidates.map((c) => [c.invoiceDate, c.parseIssues])).toEqual([
      ...rows.map(() => [null, ["INVALID_DATE"]]),
      ["2026-02-28", []],
    ]);
  });

  it("blank INV_DATE, CURRENCY and INV_TOTAL become null (validation reports MISSING_FIELD)", () => {
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,A,,,X,1,1.00,\n`));
    const c = result.candidates[0] as CanonicalCandidate;
    expect([c.invoiceDate, c.currency, c.netTotal, c.parseIssues]).toEqual([null, null, null, []]);
    expect(verdict(c)).toBe("MISSING_FIELD");
  });

  it("an unreadable QTY, UNIT_PRICE or INV_TOTAL is flagged MISSING_FIELD", () => {
    for (const row of ["UB-1,A,01/02/2026,USD,X,one,1.00,1.00", "UB-1,A,01/02/2026,USD,X,1,1.001,1.00", "UB-1,A,01/02/2026,USD,X,1,1.00,$1.00"]) {
      const c = parsed(parseText(`${HEADER_LINE}\n${row}\n`)).candidates[0] as CanonicalCandidate;
      expect(c.parseIssues).toEqual(["MISSING_FIELD"]);
    }
  });

  it("line amount is QTY x UNIT_PRICE, exact in cents", () => {
    const result = parsed(parseText(`${HEADER_LINE}\nUB-1,A,01/02/2026,USD,X,3,0.10,1.02\nUB-1,A,01/02/2026,USD,Y,7,0.10,1.02\nUB-1,A,01/02/2026,USD,Z,1.5,0.15,1.02\n`));
    const c = result.candidates[0] as CanonicalCandidate;
    expect(c.lines.map((l) => l.netAmount)).toEqual([0.3, 0.7, 0.23]);
    expect(c.lines[2]?.qty).toBe(1.5);
  });
});
