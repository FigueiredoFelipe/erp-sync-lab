// GET /api/revenue/customers?source=&customer=&from=YYYY-MM&to=YYYY-MM — thin handler: parse the query,
// call customerRevenueService.
import type { CustomerRevenueFilters, CustomerRevenueService } from "../services/customer-revenue-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";
import { parseSource, parseText, rejectUnknown, type Parsed } from "./query.ts";
import { parseMonthRange } from "./revenue-handler.ts";

export function parseCustomerFilters(params: URLSearchParams): Parsed<CustomerRevenueFilters> {
  const unknown = rejectUnknown(params, ["source", "customer", "from", "to"]);
  if (!unknown.ok) return unknown;
  const range = parseMonthRange(params);
  if (!range.ok) return range;
  const source = parseSource(params);
  if (!source.ok) return source;
  const customer = parseText(params, "customer");
  if (!customer.ok) return customer;
  return { ok: true, value: { range: range.range, source: source.value, customer: customer.value } };
}

export function createCustomerRevenueHandler(getService: () => CustomerRevenueService) {
  return async function GET(request: Request): Promise<Response> {
    const parsed = parseCustomerFilters(new URL(request.url).searchParams);
    if (!parsed.ok) return problemResponse(400, parsed.detail);
    try {
      return jsonResponse(await getService().getCustomerRevenue(parsed.value));
    } catch (error) {
      console.error("GET /api/revenue/customers failed", error);
      return problemResponse(500, "Unexpected error while reading customer revenue.");
    }
  };
}
