// invoice-consumer: called every minute by pg_cron (migration 20261018190100). Thin Deno wrapper: the
// handler logic (method, cron auth, batch, Problem Details) lives in src/http/consumer-handler.ts.
import { isAuthorizedCron } from "../_shared/cron-auth.ts";
import { rawPutter } from "../_shared/raw-store.ts";
import { serviceClient } from "../_shared/service-client.ts";
import { createConsumerHandler } from "../../../src/http/consumer-handler.ts";
import type { ConsumerDeps } from "../../../src/services/consumer-service.ts";
import { resolveHint } from "../../../src/services/webhook-service.ts";

const handler = createConsumerHandler({
  isAuthorized: (req) => isAuthorizedCron(req, Deno.env.get("CRON_SECRET")),
  buildDeps: () => {
    const client = serviceClient();
    const deps: ConsumerDeps = { rpc: { rpc: (fn, args) => client.rpc(fn, args) } };
    // Webhook hints (PLAN "Source A: webhooks") fetch the current document from ERPNext. Without the
    // ERPNEXT_* secrets a hint fails like any message (retried, then dead-lettered); other kinds still run.
    deps.resolveHint = async (name) => {
      const baseUrl = Deno.env.get("ERPNEXT_URL");
      const apiKey = Deno.env.get("ERPNEXT_API_KEY");
      const apiSecret = Deno.env.get("ERPNEXT_API_SECRET");
      if (!baseUrl || !apiKey || !apiSecret) {
        throw new Error("ERPNEXT_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET must be set to resolve webhook hints.");
      }
      return resolveHint(name, { erpnext: { baseUrl, apiKey, apiSecret }, putRaw: rawPutter(client) });
    };
    // AC03 fault injection, never enabled in production.
    if (Deno.env.get("ENABLE_TEST_SWITCHES") === "true") {
      deps.testSwitch = async (name) => {
        const { data, error } = await client.rpc("test_switch_enabled", { p_name: name });
        if (error) throw new Error(`test_switch_enabled failed: ${error.message}`);
        return data === true;
      };
    }
    return deps;
  },
});

Deno.serve(handler);
