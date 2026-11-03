// GET /api/quarantine?source=&reason= — thin handler: parse the query, call quarantineService.
import { REASON_CODES, type QuarantineFilters, type QuarantineService, type ReasonCode } from "../services/quarantine-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";
import { parseSource, rejectUnknown, type Parsed } from "./query.ts";

export function parseQuarantineFilters(params: URLSearchParams): Parsed<QuarantineFilters> {
  const unknown = rejectUnknown(params, ["source", "reason"]);
  if (!unknown.ok) return unknown;
  const source = parseSource(params);
  if (!source.ok) return source;
  const reason = params.get("reason");
  if (reason !== null && reason !== "" && !(REASON_CODES as readonly string[]).includes(reason)) {
    return { ok: false, detail: `Query parameter 'reason' must be one of: ${REASON_CODES.join(", ")}.` };
  }
  return { ok: true, value: { source: source.value, reason: reason ? (reason as ReasonCode) : null } };
}

export function createQuarantineHandler(getService: () => QuarantineService) {
  return async function GET(request: Request): Promise<Response> {
    const parsed = parseQuarantineFilters(new URL(request.url).searchParams);
    if (!parsed.ok) return problemResponse(400, parsed.detail);
    try {
      return jsonResponse(await getService().listOpen(parsed.value));
    } catch (error) {
      console.error("GET /api/quarantine failed", error);
      return problemResponse(500, "Unexpected error while reading the quarantine.");
    }
  };
}
