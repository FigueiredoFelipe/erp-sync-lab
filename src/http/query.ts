// Shared query-parameter parsing for the GET routes. Every failure is a message for a 400 Problem Details.
import { SOURCES, type Source } from "../services/customer-revenue-service.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

const MAX_TEXT = 200;

export function parseSource(params: URLSearchParams): Parsed<Source | null> {
  const value = params.get("source");
  if (value === null || value === "") return { ok: true, value: null };
  if (!(SOURCES as readonly string[]).includes(value)) {
    return { ok: false, detail: `Query parameter 'source' must be one of: ${SOURCES.join(", ")}.` };
  }
  return { ok: true, value: value as Source };
}

// Free text keys (customer key, reason code): bounded and printable.
export function parseText(params: URLSearchParams, key: string, options: { required?: boolean } = {}): Parsed<string | null> {
  const value = params.get(key);
  if (value === null || value === "") {
    return options.required ? { ok: false, detail: `Query parameter '${key}' is required.` } : { ok: true, value: null };
  }
  if (value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, detail: `Query parameter '${key}' must be at most ${MAX_TEXT} printable characters.` };
  }
  return { ok: true, value };
}

const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseMonth(params: URLSearchParams, key: string): Parsed<string> {
  const value = params.get(key);
  if (value === null || value === "") return { ok: false, detail: `Query parameter '${key}' is required.` };
  if (!YEAR_MONTH.test(value)) return { ok: false, detail: `Query parameter '${key}' must be YYYY-MM.` };
  return { ok: true, value };
}

// Rejects parameters the route doesn't know, so a typo ("cusomter=") doesn't silently return everything.
export function rejectUnknown(params: URLSearchParams, allowed: readonly string[]): Parsed<null> {
  for (const key of params.keys()) {
    if (!allowed.includes(key)) return { ok: false, detail: `Unknown query parameter '${key}'. Allowed: ${allowed.join(", ")}.` };
  }
  return { ok: true, value: null };
}
