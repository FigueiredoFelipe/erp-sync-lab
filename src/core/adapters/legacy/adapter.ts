// Source B adapter: one Unit B export file -> a whole-file rejection, or one canonical candidate per invoice
// (PLAN "Canonical model and adapters", "Source B: export file ingestion"; R03, R04, BR03, BR04, BR06).
//
// Runtime-agnostic: no Node or Deno APIs. The CSV parser (csv-parse's `parse` from "csv-parse/sync") is
// injected, because Node resolves the bare package name while an Edge Function imports it as
// "npm:csv-parse@<version>/sync". This file owns the parser options, so both runtimes parse the same way.
// The adapter only translates and flags what it finds while parsing (parseIssues); validation decides.

import type { CandidateLine, CanonicalCandidate, ReasonCode } from "../../canonical.ts";

export const SOURCE = "legacy_unit_b";
export const BUCKET = "legacy-uploads";
export const MAX_ROWS = 5_000;
export const HEADER = ["INV_NO", "CUST_NAME", "INV_DATE", "CURRENCY", "LINE_ITEM", "QTY", "UNIT_PRICE", "INV_TOTAL"] as const;

// The subset of csv-parse's options this adapter sets. Strict by default: an unclosed quote, a quote inside an
// unquoted field or a row with the wrong number of columns throws, and the whole file is rejected.
export type CsvParseOptions = {
  bom: boolean;
  skip_empty_lines: boolean;
  relax_column_count: boolean;
  relax_quotes: boolean;
  trim: boolean;
};

export type CsvParse = (input: string, options: CsvParseOptions) => string[][];

const PARSE_OPTIONS: CsvParseOptions = {
  bom: true,
  skip_empty_lines: true,
  relax_column_count: false,
  relax_quotes: false,
  trim: false,
};

export type ParseResult =
  | { kind: "rejected"; reason: string }
  | { kind: "parsed"; exportDate: string; rowCount: number; candidates: CanonicalCandidate[] };

const FILE_NAME = /^unit_b_export_(\d{4})-(\d{2})-(\d{2})\.csv$/;
const US_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const AMOUNT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;
const QUANTITY = /^(-)?(\d+)(?:\.(\d{1,4}))?$/;
const QTY_SCALE = 10_000; // QTY has at most 4 decimals; it is kept as an integer number of 1/10,000 units

// Export date (ISO) from the object name `unit_b_export_YYYY-MM-DD.csv` (or `<folder>/unit_b_export_...`),
// or null when the name doesn't carry a real calendar date.
export function exportDateOf(objectName: string): string | null {
  const base = objectName.slice(objectName.lastIndexOf("/") + 1);
  const match = FILE_NAME.exec(base);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isCalendarDate(year, month, day) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function rawRefOf(objectName: string): string {
  return `${BUCKET}/${objectName}`;
}

// Whole-file checks first (EC07): file name date, strict CSV, exact header, 1 to 5,000 data rows.
// Then rows are grouped by INV_NO in file order (BR06); a row without INV_NO is a record of its own (BR03, Q8).
export function parseFile(content: Uint8Array | string, objectName: string, parseCsv: CsvParse): ParseResult {
  const exportDate = exportDateOf(objectName);
  if (!exportDate) return reject("file name must be unit_b_export_YYYY-MM-DD.csv with a real date");

  let text: string;
  try {
    text = typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return reject("file is not valid UTF-8");
  }

  let rows: string[][];
  try {
    rows = parseCsv(text, PARSE_OPTIONS);
  } catch (error) {
    return reject(`malformed CSV: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [header, ...data] = rows;
  if (!header) return reject("file is empty");
  if (header.length !== HEADER.length || header.some((cell, i) => cell !== HEADER[i])) {
    return reject(`header must be exactly ${HEADER.join(",")}`);
  }
  if (data.length === 0) return reject("file has no data rows");
  if (data.length > MAX_ROWS) return reject(`file has ${data.length} data rows, more than ${MAX_ROWS}`);

  const ctx: Context = { objectName, exportDate };
  const groups = new Map<string, Row[]>();
  const candidates: { order: number; candidate: CanonicalCandidate }[] = [];
  data.forEach((cells, index) => {
    const row = toRow(cells, index + 1);
    if (row.invNo === "") {
      // Q8: can't be grouped, so it is quarantined on its own as MISSING_FIELD.
      const candidate = buildCandidate(ctx, `${objectName}#row${row.rowNo}`, [row]);
      candidate.parseIssues = unique(["MISSING_FIELD", ...candidate.parseIssues]);
      candidates.push({ order: row.rowNo, candidate });
      return;
    }
    const group = groups.get(row.invNo);
    if (group) group.push(row);
    else groups.set(row.invNo, [row]);
  });
  for (const [invNo, group] of groups) {
    candidates.push({ order: (group[0] as Row).rowNo, candidate: buildCandidate(ctx, invNo, group) });
  }
  candidates.sort((a, b) => a.order - b.order);

  return { kind: "parsed", exportDate, rowCount: data.length, candidates: candidates.map((c) => c.candidate) };
}

type Context = { objectName: string; exportDate: string };

// One data row, trimmed. rowNo is the 1-based data row number (the header is not counted).
type Row = {
  rowNo: number;
  invNo: string;
  custName: string;
  invDate: string;
  currency: string;
  lineItem: string;
  qty: string;
  unitPrice: string;
  invTotal: string;
};

function toRow(cells: string[], rowNo: number): Row {
  const cell = (i: number) => (cells[i] ?? "").trim();
  return {
    rowNo,
    invNo: cell(0),
    custName: cell(1),
    invDate: cell(2),
    currency: cell(3),
    lineItem: cell(4),
    qty: cell(5),
    unitPrice: cell(6),
    invTotal: cell(7),
  };
}

function buildCandidate(ctx: Context, sourceDocId: string, rows: Row[]): CanonicalCandidate {
  const issues: ReasonCode[] = [];
  const first = rows[0] as Row;

  // BR06: rows of one invoice that disagree on an invoice-level column.
  const conflicting = rows.some(
    (r) =>
      r.custName !== first.custName ||
      r.invDate !== first.invDate ||
      r.currency !== first.currency ||
      normalizedAmount(r.invTotal) !== normalizedAmount(first.invTotal),
  );
  if (conflicting) issues.push("CONFLICTING_DUPLICATE");

  const netTotalCents = parseScaled(first.invTotal, AMOUNT, 100);
  if (first.invTotal !== "" && netTotalCents === null) issues.push("MISSING_FIELD");

  const parsedLines = rows.map((r) => {
    const qty = parseScaled(r.qty, QUANTITY, QTY_SCALE);
    const unitPriceCents = parseScaled(r.unitPrice, AMOUNT, 100);
    if (qty === null || unitPriceCents === null) issues.push("MISSING_FIELD");
    return { row: r, qty: qty ?? 0, unitPriceCents: unitPriceCents ?? 0, netCents: lineCents(qty ?? 0, unitPriceCents ?? 0) };
  });

  const kept = conflicting || netTotalCents === null ? parsedLines : arbitrateRepeats(parsedLines, netTotalCents);

  const invoiceDate = parseUsDate(first.invDate);
  if (first.invDate !== "" && invoiceDate === null) issues.push("INVALID_DATE");

  const lines: CandidateLine[] = kept.map((l, i) => ({
    lineNo: i + 1,
    itemCode: null,
    description: l.row.lineItem === "" ? null : l.row.lineItem,
    qty: l.qty / QTY_SCALE,
    unitPrice: l.unitPriceCents / 100,
    netAmount: l.netCents / 100,
  }));

  return {
    source: SOURCE,
    sourceDocId,
    sourceVersion: ctx.exportDate,
    rawRef: rawRefOf(ctx.objectName),
    sourceCustomer: first.custName === "" ? null : first.custName,
    invoiceDate,
    currency: first.currency === "" ? null : first.currency,
    isCreditNote: false, // Source B has no credit-note marker
    status: "final",
    netTotal: netTotalCents === null ? null : netTotalCents / 100,
    lines,
    parseIssues: unique(issues),
  };
}

type ParsedLine = { row: Row; qty: number; unitPriceCents: number; netCents: number };

// BR06, identical repeated rows: INV_TOTAL decides. If it matches the line sum with each repeated row counted
// once, the repeats are export duplicates and are dropped. Otherwise every row is kept: either it matches with all
// of them (real identical lines), or it matches neither and BR02 (TOTAL_MISMATCH) decides. Never dropped silently.
function arbitrateRepeats(lines: ParsedLine[], netTotalCents: number): ParsedLine[] {
  const seen = new Set<string>();
  const deduped = lines.filter((l) => {
    const key = rowHash(l.row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length === lines.length) return lines;
  return withinTolerance(sum(deduped), netTotalCents) ? deduped : lines;
}

// Same tolerance as BR02 (USD 0.01), so arbitration and validation agree on what "matches" means.
function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

function sum(lines: ParsedLine[]): number {
  return lines.reduce((total, l) => total + l.netCents, 0);
}

// All columns, trimmed, with amounts in canonical form ("10" and "10.00" are the same price).
function rowHash(r: Row): string {
  return [
    r.invNo,
    r.custName,
    r.invDate,
    r.currency,
    r.lineItem,
    normalizedQty(r.qty),
    normalizedAmount(r.unitPrice),
    normalizedAmount(r.invTotal),
  ].join("\u0000");
}

function normalizedAmount(text: string): string {
  const cents = parseScaled(text, AMOUNT, 100);
  return cents === null ? `?${text}` : String(cents);
}

function normalizedQty(text: string): string {
  const scaled = parseScaled(text, QUANTITY, QTY_SCALE);
  return scaled === null ? `?${text}` : String(scaled);
}

// Decimal text -> integer in 1/scale units, without floating point. null when it isn't a plain decimal.
function parseScaled(text: string, pattern: RegExp, scale: number): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const [, minus, whole = "0", fraction = ""] = match;
  const digits = String(scale).length - 1;
  const value = Number(whole) * scale + Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(value)) return null;
  return minus && value !== 0 ? -value : value;
}

// QTY x UNIT_PRICE in cents. Exact for whole quantities; a fractional quantity rounds half away from zero.
function lineCents(qtyScaled: number, unitPriceCents: number): number {
  const product = qtyScaled * unitPriceCents;
  const cents = Math.round(Math.abs(product) / QTY_SCALE);
  return product < 0 ? -cents : cents;
}

// BR03: Source B dates are strictly MM/DD/YYYY and must be a real calendar date.
function parseUsDate(text: string): string | null {
  const match = US_DATE.exec(text);
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isCalendarDate(year, month, day) ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function unique(issues: ReasonCode[]): ReasonCode[] {
  return [...new Set(issues)];
}

function reject(reason: string): ParseResult {
  return { kind: "rejected", reason };
}
