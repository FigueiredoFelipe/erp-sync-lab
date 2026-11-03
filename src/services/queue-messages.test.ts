import { describe, expect, it } from "@jest/globals";
import type { CanonicalCandidate } from "../core/canonical.ts";
import { MalformedMessageError, parseCandidate, parseMessage } from "./queue-messages.ts";

function candidate(overrides: Record<string, unknown> = {}): CanonicalCandidate {
  return {
    source: "legacy_unit_b",
    sourceDocId: "UB-26004",
    sourceVersion: "2026-10-16",
    rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
    sourceCustomer: "ACME FOODS",
    invoiceDate: "2026-01-12",
    currency: "USD",
    isCreditNote: false,
    status: "final",
    netTotal: 10,
    lines: [{ lineNo: 1, itemCode: null, description: "x", qty: 1, unitPrice: 10, netAmount: 10 }],
    parseIssues: [],
    ...overrides,
  } as CanonicalCandidate;
}

const legacy = (c: unknown = candidate(), extra: Record<string, unknown> = {}) => ({
  v: 1,
  kind: "record",
  source: "legacy_unit_b",
  sourceDocId: "UB-26004",
  sourceVersion: "2026-10-16",
  rawRef: "legacy-uploads/unit_b_export_2026-10-16.csv",
  candidate: c,
  ...extra,
});

describe("parseMessage: Source B record", () => {
  it("accepts the contract shape and returns the candidate", () => {
    const event = parseMessage(legacy());
    expect(event).toMatchObject({ kind: "record", source: "legacy_unit_b", sourceDocId: "UB-26004" });
    expect("candidate" in event && event.candidate.netTotal).toBe(10);
  });

  it("accepts a #row key and unreadable amounts flagged MISSING_FIELD (as 0)", () => {
    const key = "unit_b_export_2026-10-16.csv#row7";
    const c = candidate({ sourceDocId: key, parseIssues: ["MISSING_FIELD"], netTotal: null, lines: [{ lineNo: 1, itemCode: null, description: null, qty: null, unitPrice: 2, netAmount: null }] });
    const event = parseMessage(legacy(c, { sourceDocId: key }));
    expect("candidate" in event && event.candidate.lines[0]).toMatchObject({ qty: 0, netAmount: 0 });
  });

  it.each([
    ["a candidate of another invoice", legacy(candidate({ sourceDocId: "UB-1" }))],
    ["a candidate of another version", legacy(candidate({ sourceVersion: "2026-10-17" }))],
    ["a timestamp version", legacy(candidate(), { sourceVersion: "1|2026-10-16 00:00:00.000000" })],
    ["a rawRef outside legacy-uploads", legacy(candidate({ rawRef: "x" }), { rawRef: "x" })],
    ["no candidate", legacy(null)],
    ["a cancelled Source B candidate", legacy(candidate({ status: "cancelled" }))],
    ["an unknown parse issue", legacy(candidate({ parseIssues: ["UNKNOWN_CUSTOMER"] }))],
    ["a null amount without MISSING_FIELD", legacy(candidate({ lines: [{ lineNo: 1, itemCode: null, description: null, qty: null, unitPrice: 1, netAmount: 1 }] }))],
    ["duplicate line numbers", legacy(candidate({ lines: [candidate().lines[0], candidate().lines[0]] }))],
    ["a string amount", legacy(candidate({ netTotal: "10" }))],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseMessage(raw)).toThrow(MalformedMessageError);
  });
});

describe("parseMessage: tombstones", () => {
  it("accepts an ERPNext tombstone with a 3| version", () => {
    expect(parseMessage({ v: 1, kind: "tombstone", source: "erpnext", sourceDocId: "ACC-SINV-2026-00009", sourceVersion: "3|2026-10-18 14:00:00.000000", rawRef: "r" })).toEqual({
      v: 1,
      kind: "tombstone",
      source: "erpnext",
      sourceDocId: "ACC-SINV-2026-00009",
      sourceVersion: "3|2026-10-18 14:00:00.000000",
    });
  });

  it("accepts a Source B tombstone with an export date", () => {
    expect(parseMessage({ v: 1, kind: "tombstone", source: "legacy_unit_b", sourceDocId: "UB-26001", sourceVersion: "2026-10-17" })).toMatchObject({
      kind: "tombstone",
      source: "legacy_unit_b",
    });
  });

  it.each([
    ["an ERPNext tombstone with a 2| version", { source: "erpnext", sourceVersion: "2|2026-10-18 14:00:00.000000" }],
    ["an ERPNext tombstone with a short timestamp", { source: "erpnext", sourceVersion: "3|2026-10-18 14:00:00" }],
    ["a Source B tombstone with a timestamp", { source: "legacy_unit_b", sourceVersion: "3|2026-10-18 14:00:00.000000" }],
    ["no key", { source: "legacy_unit_b", sourceVersion: "2026-10-17", sourceDocId: "" }],
  ])("rejects %s", (_label, fields) => {
    expect(() => parseMessage({ v: 1, kind: "tombstone", sourceDocId: "X", ...fields })).toThrow(MalformedMessageError);
  });
});

describe("parseCandidate", () => {
  it("accepts a stored ERPNext candidate without an expected version", () => {
    const c = candidate({ source: "erpnext", sourceDocId: "A", sourceVersion: "1|2026-10-17 20:39:07.886022", rawRef: "erpnext/A/1.json" });
    expect(parseCandidate(c, { source: "erpnext", sourceDocId: "A" }).sourceVersion).toBe("1|2026-10-17 20:39:07.886022");
  });
});
