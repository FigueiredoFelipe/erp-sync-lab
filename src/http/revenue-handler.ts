// GET /api/revenue/monthly?from=YYYY-MM&to=YYYY-MM — thin handler: parse the query, call revenueService.
import type { MonthRange, RevenueService } from "../services/revenue-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";

// The demo dataset covers January to October 2026 (SPEC R08).
export const DEFAULT_RANGE: MonthRange = { from: "2026-01", to: "2026-10" };
const MAX_MONTHS = 120;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type RangeResult = { ok: true; range: MonthRange } | { ok: false; detail: string };

export function parseMonthRange(params: URLSearchParams): RangeResult {
  const range: MonthRange = { ...DEFAULT_RANGE };
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!YEAR_MONTH.test(value)) return { ok: false, detail: `Query parameter '${key}' must be YYYY-MM.` };
    range[key] = value;
  }
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  if (index(range.from) > index(range.to)) return { ok: false, detail: "'from' must not be after 'to'." };
  if (index(range.to) - index(range.from) + 1 > MAX_MONTHS) {
    return { ok: false, detail: `The range may span at most ${MAX_MONTHS} months.` };
  }
  return { ok: true, range };
}

export function createRevenueMonthlyHandler(getService: () => RevenueService) {
  return async function GET(request: Request): Promise<Response> {
    const parsed = parseMonthRange(new URL(request.url).searchParams);
    if (!parsed.ok) return problemResponse(400, parsed.detail);
    try {
      return jsonResponse(await getService().getMonthlyRevenue(parsed.range));
    } catch (error) {
      console.error("GET /api/revenue/monthly failed", error);
      return problemResponse(500, "Unexpected error while reading monthly revenue.");
    }
  };
}
