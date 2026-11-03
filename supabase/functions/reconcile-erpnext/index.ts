// reconcile-erpnext: called daily by pg_cron (migration 20261018210100) or on demand with
// select internal.trigger_reconcile(). Thin Deno wrapper: the handler logic lives in src/http/reconcile-handler.ts.
import { isAuthorizedCron } from "../_shared/cron-auth.ts";
import { serviceClient } from "../_shared/service-client.ts";
import { createReconcileHandler } from "../../../src/http/reconcile-handler.ts";

const handler = createReconcileHandler({
  isAuthorized: (req) => isAuthorizedCron(req, Deno.env.get("CRON_SECRET")),
  buildDeps: () => {
    const baseUrl = Deno.env.get("ERPNEXT_URL");
    const apiKey = Deno.env.get("ERPNEXT_API_KEY");
    const apiSecret = Deno.env.get("ERPNEXT_API_SECRET");
    if (!baseUrl || !apiKey || !apiSecret) {
      throw new Error("ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET must be set.");
    }
    const client = serviceClient();
    return { rpc: { rpc: (fn, args) => client.rpc(fn, args) }, erpnext: { baseUrl, apiKey, apiSecret } };
  },
});

Deno.serve(handler);
