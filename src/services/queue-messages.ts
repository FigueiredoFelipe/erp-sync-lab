// Strict parsing of invoice_events messages (PLAN "Queue, consumers and failures"). Anything that doesn't
// match a known shape exactly is malformed: an error, retried with backoff, then dead-lettered (R13).
//
//   record    erpnext        { v:1, kind, source, sourceDocId, sourceVersion "<1|2>|<modified>", rawRef, doc }
//   record    legacy_unit_b  { v:1, kind, source, sourceDocId, sourceVersion "YYYY-MM-DD", rawRef, candidate }
//   tombstone erpnext        { v:1, kind, source, sourceDocId, sourceVersion "3|<Deleted Document creation>", rawRef }
//   tombstone legacy_unit_b  { v:1, kind, source, sourceDocId, sourceVersion "YYYY-MM-DD" }
//   revalidate (either)      { v:1, kind, source, sourceDocId }   (enqueued by apply_customer_mapping, R15)
//   hint      erpnext        { v:1, kind, source, sourceDocId }   (enqueued by erpnext-webhook through enqueue_hint, exactly these keys)

import type { CandidateLine, CanonicalCandidate, ReasonCode, SourceId } from "../core/canonical.ts";
import { sourceVersionOf, type ErpInvoiceDoc } from "../core/adapters/erpnext/adapter.ts";

export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMessageError";
  }
}

export type RecordMessage = {
  v: 1;
  kind: "record";
  source: "erpnext";
  sourceDocId: string;
  sourceVersion: string;
  rawRef: string;
  doc: ErpInvoiceDoc;
};

export type LegacyRecordMessage = {
  v: 1;
  kind: "record";
  source: "legacy_unit_b";
  sourceDocId: string;
  sourceVersion: string;
  rawRef: string;
  candidate: CanonicalCandidate;
};

export type TombstoneMessage = {
  v: 1;
  kind: "tombstone";
  source: SourceId;
  sourceDocId: string;
  sourceVersion: string;
};

export type RevalidateMessage = {
  v: 1;
  kind: "revalidate";
  source: SourceId;
  sourceDocId: string;
};

// A webhook's latency hint: only the invoice name. The consumer fetches the current document (PLAN "Source A: webhooks").
export type HintMessage = {
  v: 1;
  kind: "hint";
  source: "erpnext";
  sourceDocId: string;
};

export type QueueEvent = RecordMessage | LegacyRecordMessage | TombstoneMessage | RevalidateMessage | HintMessage;

const HINT_KEYS = ["kind", "source", "sourceDocId", "v"];

const ERP_MODIFIED = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}`;
export const ERP_RECORD_VERSION = new RegExp(`^[12]\\|${ERP_MODIFIED}$`);
export const ERP_TOMBSTONE_VERSION = new RegExp(`^3\\|${ERP_MODIFIED}$`);
export const EXPORT_DATE_VERSION = /^\d{4}-\d{2}-\d{2}$/;

// Codes a Source B adapter may report while parsing; the rest are decided by validation or the DLQ.
const PARSE_ISSUES: readonly ReasonCode[] = ["MISSING_FIELD", "INVALID_DATE", "CONFLICTING_DUPLICATE"];

export function parseMessage(raw: unknown): QueueEvent {
  if (!isObject(raw)) throw new MalformedMessageError("message is not an object");
  if (raw["v"] !== 1) throw new MalformedMessageError(`unsupported message version ${String(raw["v"])}`);
  const kind = raw["kind"];
  const source = raw["source"];
  if (source !== "erpnext" && source !== "legacy_unit_b") throw new MalformedMessageError(`unsupported source ${String(source)}`);
  const sourceDocId = requireKey(raw);
  if (kind === "record") return source === "erpnext" ? parseErpRecord(raw, sourceDocId) : parseLegacyRecord(raw, sourceDocId);
  if (kind === "tombstone") return parseTombstone(raw, source, sourceDocId);
  if (kind === "revalidate") return { v: 1, kind: "revalidate", source, sourceDocId };
  if (kind === "hint") return parseHint(raw, source, sourceDocId);
  throw new MalformedMessageError(`unsupported message kind ${String(kind)}`);
}

function parseErpRecord(raw: Record<string, unknown>, sourceDocId: string): RecordMessage {
  const { sourceVersion, rawRef, doc } = raw;
  if (typeof sourceVersion !== "string" || !ERP_RECORD_VERSION.test(sourceVersion)) {
    throw new MalformedMessageError(`invalid sourceVersion ${JSON.stringify(sourceVersion)}`);
  }
  if (typeof rawRef !== "string" || rawRef === "") throw new MalformedMessageError("missing rawRef");
  if (!isObject(doc)) throw new MalformedMessageError("missing doc");
  if (doc["name"] !== sourceDocId) throw new MalformedMessageError("doc.name differs from sourceDocId");
  let docVersion: string;
  try {
    docVersion = sourceVersionOf(doc as ErpInvoiceDoc);
  } catch (error) {
    throw new MalformedMessageError(`doc has no valid version: ${(error as Error).message}`);
  }
  // A draft (docstatus 0) is never valid input (BR01, AC06): its version can't match.
  if (docVersion !== sourceVersion) throw new MalformedMessageError("doc version differs from sourceVersion");
  return { v: 1, kind: "record", source: "erpnext", sourceDocId, sourceVersion, rawRef, doc: doc as ErpInvoiceDoc };
}

function parseLegacyRecord(raw: Record<string, unknown>, sourceDocId: string): LegacyRecordMessage {
  const { sourceVersion, rawRef } = raw;
  if (typeof sourceVersion !== "string" || !EXPORT_DATE_VERSION.test(sourceVersion)) {
    throw new MalformedMessageError(`invalid sourceVersion ${JSON.stringify(sourceVersion)}`);
  }
  if (typeof rawRef !== "string" || !rawRef.startsWith("legacy-uploads/")) throw new MalformedMessageError("missing rawRef");
  const candidate = parseCandidate(raw["candidate"], { source: "legacy_unit_b", sourceDocId, sourceVersion, rawRef });
  return { v: 1, kind: "record", source: "legacy_unit_b", sourceDocId, sourceVersion, rawRef, candidate };
}

function parseHint(raw: Record<string, unknown>, source: SourceId, sourceDocId: string): HintMessage {
  if (source !== "erpnext") throw new MalformedMessageError(`a hint comes only from erpnext, not ${source}`);
  if (Object.keys(raw).sort().join(",") !== HINT_KEYS.join(",")) throw new MalformedMessageError("a hint carries only v, kind, source and sourceDocId");
  return { v: 1, kind: "hint", source: "erpnext", sourceDocId };
}

function parseTombstone(raw: Record<string, unknown>, source: SourceId, sourceDocId: string): TombstoneMessage {
  const { sourceVersion } = raw;
  const pattern = source === "erpnext" ? ERP_TOMBSTONE_VERSION : EXPORT_DATE_VERSION;
  if (typeof sourceVersion !== "string" || !pattern.test(sourceVersion)) {
    throw new MalformedMessageError(`invalid tombstone sourceVersion ${JSON.stringify(sourceVersion)}`);
  }
  return { v: 1, kind: "tombstone", source, sourceDocId, sourceVersion };
}

// A canonical candidate that arrived already parsed (Source B) or was stored with an invoice or a
// quarantine row (revalidate). Its key must be the expected one; every field has its exact type.
export function parseCandidate(
  raw: unknown,
  expected: { source: SourceId; sourceDocId: string; sourceVersion?: string; rawRef?: string },
): CanonicalCandidate {
  if (!isObject(raw)) throw new MalformedMessageError("missing candidate");
  const c = raw;
  if (c["source"] !== expected.source || c["sourceDocId"] !== expected.sourceDocId) {
    throw new MalformedMessageError("candidate key differs from the message");
  }
  const sourceVersion = c["sourceVersion"];
  if (typeof sourceVersion !== "string" || (expected.sourceVersion !== undefined && sourceVersion !== expected.sourceVersion)) {
    throw new MalformedMessageError("candidate version differs from the message");
  }
  const versionPattern = expected.source === "erpnext" ? ERP_RECORD_VERSION : EXPORT_DATE_VERSION;
  if (!versionPattern.test(sourceVersion)) throw new MalformedMessageError(`invalid candidate version ${JSON.stringify(sourceVersion)}`);
  const rawRef = c["rawRef"];
  if (typeof rawRef !== "string" || rawRef === "" || (expected.rawRef !== undefined && rawRef !== expected.rawRef)) {
    throw new MalformedMessageError("candidate rawRef differs from the message");
  }
  const status = c["status"];
  if (status !== "final" && !(status === "cancelled" && expected.source === "erpnext")) {
    throw new MalformedMessageError(`invalid candidate status ${String(status)}`);
  }
  const parseIssues = c["parseIssues"];
  if (!Array.isArray(parseIssues) || !parseIssues.every((code) => PARSE_ISSUES.includes(code as ReasonCode))) {
    throw new MalformedMessageError("invalid candidate parseIssues");
  }
  const issues = parseIssues as ReasonCode[];
  // An unreadable number is reported by the adapter as MISSING_FIELD; validation then quarantines the record,
  // so the placeholder 0 never reaches the figures.
  const missingAllowed = issues.includes("MISSING_FIELD");
  if (typeof c["isCreditNote"] !== "boolean") throw new MalformedMessageError("invalid candidate isCreditNote");
  const lines = c["lines"];
  if (!Array.isArray(lines)) throw new MalformedMessageError("invalid candidate lines");
  const parsedLines = lines.map((line, i) => parseLine(line, i, missingAllowed));
  if (new Set(parsedLines.map((l) => l.lineNo)).size !== parsedLines.length) throw new MalformedMessageError("duplicate candidate lineNo");
  return {
    source: expected.source,
    sourceDocId: expected.sourceDocId,
    sourceVersion,
    rawRef,
    sourceCustomer: stringOrNull(c["sourceCustomer"], "sourceCustomer"),
    invoiceDate: stringOrNull(c["invoiceDate"], "invoiceDate"),
    currency: stringOrNull(c["currency"], "currency"),
    isCreditNote: c["isCreditNote"],
    status,
    netTotal: numberOrNull(c["netTotal"], "netTotal"),
    lines: parsedLines,
    parseIssues: [...issues],
  };
}

function parseLine(raw: unknown, index: number, missingAllowed: boolean): CandidateLine {
  if (!isObject(raw)) throw new MalformedMessageError(`invalid candidate line ${index + 1}`);
  const lineNo = raw["lineNo"];
  if (typeof lineNo !== "number" || !Number.isInteger(lineNo) || lineNo < 1) throw new MalformedMessageError(`invalid lineNo in line ${index + 1}`);
  const amount = (field: string): number => {
    const value = raw[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (missingAllowed && (value === null || value === undefined)) return 0;
    throw new MalformedMessageError(`invalid ${field} in line ${lineNo}`);
  };
  return {
    lineNo,
    itemCode: stringOrNull(raw["itemCode"], "itemCode"),
    description: stringOrNull(raw["description"], "description"),
    qty: amount("qty"),
    unitPrice: amount("unitPrice"),
    netAmount: amount("netAmount"),
  };
}

function requireKey(raw: Record<string, unknown>): string {
  const sourceDocId = raw["sourceDocId"];
  if (typeof sourceDocId !== "string" || sourceDocId === "") throw new MalformedMessageError("missing sourceDocId");
  return sourceDocId;
}

function stringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new MalformedMessageError(`invalid candidate ${field}`);
  return value;
}

function numberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MalformedMessageError(`invalid candidate ${field}`);
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
