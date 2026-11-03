// erpnext-webhook: called by ERPNext's Webhook on Sales Invoice (docs/erpnext-webhook.md has the exact
// configuration). Deployed with verify_jwt = false (supabase/config.toml): ERPNext can't send a Supabase
// JWT, so the HMAC signature is the authentication. Thin Deno wrapper around src/http/erpnext-webhook-handler.ts.
import { serviceClient } from "../_shared/service-client.ts";
import { createErpnextWebhookHandler } from "../../../src/http/erpnext-webhook-handler.ts";

const handler = createErpnextWebhookHandler({
  secret: () => Deno.env.get("ERPNEXT_WEBHOOK_SECRET"),
  buildRpc: () => {
    const client = serviceClient();
    return { rpc: (fn, args) => client.rpc(fn, args) };
  },
});

Deno.serve(handler);
