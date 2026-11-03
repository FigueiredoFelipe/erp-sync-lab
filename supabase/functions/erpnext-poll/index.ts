// erpnext-poll: called by pg_cron every 5 minutes (internal.trigger_poll). Thin handler: authenticate
// the caller, build the dependencies, call pollService (PLAN "Source A: incremental fetch").
import { runErpnextPoll } from "../../../src/services/poll-service.ts";
import { isAuthorizedCron } from "../_shared/cron-auth.ts";
import { rawPutter } from "../_shared/raw-store.ts";
import { serviceClient } from "../_shared/service-client.ts";

const PROBLEM = { "Content-Type": "application/problem+json" };

function problem(status: number, title: string, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail }), { status, headers: PROBLEM });
}

Deno.serve(async (req) => {
  if (!isAuthorizedCron(req, Deno.env.get("CRON_SECRET"))) {
    return problem(401, "Unauthorized", "Missing or invalid x-cron-secret header.");
  }

  const baseUrl = Deno.env.get("ERPNEXT_URL");
  const apiKey = Deno.env.get("ERPNEXT_API_KEY");
  const apiSecret = Deno.env.get("ERPNEXT_API_SECRET");
  if (!baseUrl || !apiKey || !apiSecret) {
    return problem(500, "Misconfigured", "ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET must be set.");
  }

  const supabase = serviceClient();
  const result = await runErpnextPoll({
    rpc: { rpc: (fn, args) => supabase.rpc(fn, args) },
    putRaw: rawPutter(supabase),
    erpnext: { baseUrl, apiKey, apiSecret },
  });

  // A failed run is recorded in sync_run; the HTTP status only says the handler ran.
  return Response.json(result, { status: 200 });
});
