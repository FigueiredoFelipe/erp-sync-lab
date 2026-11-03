// POST invoice-consumer (called by pg_cron every minute) — thin handler: authenticate the cron call,
// run one batch, report counts. Runtime-agnostic; the Edge Function injects the auth check and the deps.
import { processBatch, type BatchResult, type ConsumerDeps } from "../services/consumer-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";

export type ConsumerHandlerDeps = {
  isAuthorized: (request: Request) => boolean;
  buildDeps: () => ConsumerDeps;
  run?: (deps: ConsumerDeps) => Promise<BatchResult>;
};

export function createConsumerHandler({ isAuthorized, buildDeps, run = processBatch }: ConsumerHandlerDeps) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return problemResponse(405, `Method ${request.method} is not allowed; use POST.`, { allow: "POST" });
    }
    if (!isAuthorized(request)) {
      return problemResponse(401, "Missing or wrong x-cron-secret header.");
    }
    try {
      return jsonResponse(await run(buildDeps()));
    } catch (error) {
      console.error("invoice-consumer batch failed", error);
      return problemResponse(500, error instanceof Error ? error.message : String(error));
    }
  };
}
