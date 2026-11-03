# ERPNext webhook setup

Optional: without the webhook, the 5-minute poll still picks up every change.

Done once by the owner in the ERPNext UI (code never writes to ERPNext). Create one Webhook per event, all identical
except **Doc Event** (ERPNext allows one event per Webhook):

| Field | Value |
|---|---|
| DocType | `Sales Invoice` |
| Doc Event | `on_submit`, `on_cancel`, `on_update_after_submit`, `on_trash` (four Webhooks) |
| Request URL | `https://<project-ref>.supabase.co/functions/v1/erpnext-webhook` |
| Request Method | `POST` |
| Enable Security | checked; **Webhook Secret** = the same value as the Supabase secret `ERPNEXT_WEBHOOK_SECRET` |
| Headers | `Content-Type` = `application/json` (ERPNext sends none by itself) |
| Request Structure | `JSON` |
| JSON Request Body | `{"name": "{{ doc.name }}"}` |
| Condition | empty |

With Enable Security on, ERPNext adds `X-Frappe-Webhook-Signature` = base64(HMAC-SHA256(secret, body)). The function
is deployed with `verify_jwt = false` (only this one, in `supabase/config.toml`), because ERPNext can't send a Supabase JWT.

Secret (never in the repository, never printed): `supabase secrets set ERPNEXT_WEBHOOK_SECRET=…` on the project, and
the same value in the four Webhooks.

### AC09 — bad or missing signature

1. `select queue_length from pgmq.metrics('invoice_events');` → note N.
2. `curl -i -X POST https://<project-ref>.supabase.co/functions/v1/erpnext-webhook -H 'Content-Type: application/json' -d '{"name":"ACC-SINV-2026-00001"}'`
   → `401`, `Content-Type: application/problem+json`.
3. The same with `-H 'X-Frappe-Webhook-Signature: AAAA'` → `401`.
4. `pgmq.metrics` again → still N.

