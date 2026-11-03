// Pure validation (PLAN "Validation and quarantine"): stops at the first failing rule, so an invalid record gets exactly one reason code.
// Order from the spec: BR03 -> BR04 -> BR06 -> BR02 -> BR05. BR01 (cancelled) short-circuits before any check.

import type { CanonicalCandidate, ReasonCode } from "../canonical.ts";
import { resolveCustomer, type CustomerIndex } from "../customers/resolve.ts";

export type ValidationConfig = { periodStart: string; periodEnd: string };

export type ValidationResult =
  | { kind: "valid"; canonicalCustomerId: string }
  | { kind: "invalid"; reasonCode: ReasonCode }
  | { kind: "cancelled" };

export const defaultValidationConfig: ValidationConfig = { periodStart: "2026-01-01", periodEnd: "2026-12-31" };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TOLERANCE_CENTS = 1;

export function validate(
  candidate: CanonicalCandidate,
  customers: CustomerIndex,
  config: ValidationConfig = defaultValidationConfig,
): ValidationResult {
  // BR01: a cancelled invoice is removed from the figures, whatever its content.
  if (candidate.status === "cancelled") return { kind: "cancelled" };

  if (missingField(candidate)) return invalid("MISSING_FIELD");
  if (!dateIsValid(candidate, config)) return invalid("INVALID_DATE");

  // BR04: no currency conversion.
  if (candidate.currency !== "USD") return invalid("UNSUPPORTED_CURRENCY");

  // BR06: rows of one Source B invoice disagree on an invoice-level column (flagged while grouping).
  if (candidate.parseIssues.includes("CONFLICTING_DUPLICATE")) return invalid("CONFLICTING_DUPLICATE");

  if (!totalsMatch(candidate)) return invalid("TOTAL_MISMATCH");

  // BR05: the mapping decides; a customer it doesn't list waits in quarantine.
  const canonicalCustomerId = resolveCustomer(customers, candidate.source, candidate.sourceCustomer);
  if (canonicalCustomerId === null) return invalid("UNKNOWN_CUSTOMER");

  return { kind: "valid", canonicalCustomerId };
}

function invalid(reasonCode: ReasonCode): ValidationResult {
  return { kind: "invalid", reasonCode };
}

// BR03, required fields. A null invoiceDate is missing unless the adapter flagged it INVALID_DATE (it nulls a malformed date).
function missingField(c: CanonicalCandidate): boolean {
  return (
    c.parseIssues.includes("MISSING_FIELD") ||
    (c.invoiceDate === null && !c.parseIssues.includes("INVALID_DATE")) ||
    isBlank(c.sourceCustomer) ||
    isBlank(c.currency) ||
    c.netTotal === null ||
    c.lines.length === 0
  );
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

// BR03, dates: strict YYYY-MM-DD, a real calendar date, inside the configured period (inclusive).
function dateIsValid(c: CanonicalCandidate, config: ValidationConfig): boolean {
  if (c.parseIssues.includes("INVALID_DATE") || c.invoiceDate === null) return false;
  if (!isCalendarDate(c.invoiceDate)) return false;
  // ISO dates compare correctly as strings.
  return c.invoiceDate >= config.periodStart && c.invoiceDate <= config.periodEnd;
}

function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// BR02: compared in integer cents, so float sums like 0.1 + 0.2 don't break the tolerance.
function totalsMatch(c: CanonicalCandidate): boolean {
  const totalCents = toCents(c.netTotal ?? 0);
  const linesCents = c.lines.reduce((sum, line) => sum + toCents(line.netAmount), 0);
  return Math.abs(totalCents - linesCents) <= TOLERANCE_CENTS;
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}
