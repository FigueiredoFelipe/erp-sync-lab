// GET /api/freshness — thin handler: call freshnessService.
import { InjectedFailureError, type FreshnessService } from "../services/freshness-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";

export function createFreshnessHandler(getService: () => FreshnessService) {
  return async function GET(_request: Request): Promise<Response> {
    try {
      return jsonResponse(await getService().getFreshness());
    } catch (error) {
      console.error("GET /api/freshness failed", error);
      const detail = error instanceof InjectedFailureError ? error.message : "Unexpected error while reading freshness.";
      return problemResponse(500, detail);
    }
  };
}
