// GET /api/revenue/documents?customer=&month=YYYY-MM[&source=] — thin handler: parse the query,
// call documentsService.
import type { DocumentFilters, DocumentsService } from "../services/documents-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";
import { parseMonth, parseSource, parseText, rejectUnknown, type Parsed } from "./query.ts";

export function parseDocumentFilters(params: URLSearchParams): Parsed<DocumentFilters> {
  const unknown = rejectUnknown(params, ["customer", "month", "source"]);
  if (!unknown.ok) return unknown;
  const customer = parseText(params, "customer", { required: true });
  if (!customer.ok) return customer;
  const month = parseMonth(params, "month");
  if (!month.ok) return month;
  const source = parseSource(params);
  if (!source.ok) return source;
  return { ok: true, value: { customer: customer.value as string, month: month.value, source: source.value } };
}

export function createDocumentsHandler(getService: () => DocumentsService) {
  return async function GET(request: Request): Promise<Response> {
    const parsed = parseDocumentFilters(new URL(request.url).searchParams);
    if (!parsed.ok) return problemResponse(400, parsed.detail);
    try {
      return jsonResponse(await getService().getDocuments(parsed.value));
    } catch (error) {
      console.error("GET /api/revenue/documents failed", error);
      return problemResponse(500, "Unexpected error while reading the source documents.");
    }
  };
}
