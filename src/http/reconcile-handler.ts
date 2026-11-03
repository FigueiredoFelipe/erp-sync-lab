// POST reconcile-erpnext (called daily by pg_cron, or on demand with select internal.trigger_reconcile())
// — thin handler: authenticate the cron call, run one reconciliation, report its summary.
// Runtime-agnostic; the Edge Function injects the auth check and the deps.
import { runReconciliation, type ReconcileDeps, type ReconcileResult } from "../services/reconciliation-service.ts";
import { jsonResponse, problemResponse } from "./problem.ts";

export type ReconcileHandlerDeps = {
  isAuthorized: (request: Request) => boolean;
  buildDeps: () => ReconcileDeps;
  run?: (deps: ReconcileDeps) => Promise<ReconcileResult>;
};

export function createReconcileHandler({ isAuthorized, buildDeps, run = runReconciliation }: ReconcileHandlerDeps) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return problemResponse(405, `Method ${request.method} is not allowed; use POST.`, { allow: "POST" });
    }
    if (!isAuthorized(request)) {
      return problemResponse(401, "Missing or wrong x-cron-secret header.");
    }
    try {
      // A failed run (ERPNext down, bad data) is recorded in reconciliation_run and reported with 200:
      // the HTTP status only says the handler ran.
      return jsonResponse(await run(buildDeps()));
    } catch (error) {
      console.error("reconcile-erpnext failed", error);
      return problemResponse(500, error instanceof Error ? error.message : String(error));
    }
  };
}
