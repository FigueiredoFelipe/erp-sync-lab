// legacy-ingest: called by pg_cron every 5 minutes (internal.trigger_legacy_ingest). Thin handler: authenticate
// the caller, build the dependencies, call legacyIngestService (PLAN "Source B: export file ingestion").
// csv-parse is imported here with Deno's npm: specifier and injected, so src/ stays runtime-agnostic; the
// version matches package.json exactly.
import { parse } from "npm:csv-parse@7.0.3/sync";
import { BUCKET } from "../../../src/core/adapters/legacy/adapter.ts";
import { runLegacyIngest } from "../../../src/services/legacy-ingest-service.ts";
import { isAuthorizedCron } from "../_shared/cron-auth.ts";
import { serviceClient } from "../_shared/service-client.ts";

const PROBLEM = { "Content-Type": "application/problem+json" };

function problem(status: number, title: string, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail }), { status, headers: PROBLEM });
}

// Enough for a lab bucket; the run takes the oldest pending export date among these.
const LIST_LIMIT = 1000;

Deno.serve(async (req) => {
  if (!isAuthorizedCron(req, Deno.env.get("CRON_SECRET"))) {
    return problem(401, "Unauthorized", "Missing or invalid x-cron-secret header.");
  }

  const supabase = serviceClient();
  const bucket = supabase.storage.from(BUCKET);
  const result = await runLegacyIngest({
    rpc: { rpc: (fn, args) => supabase.rpc(fn, args) },
    listObjects: async () => {
      const { data, error } = await bucket.list("", { limit: LIST_LIMIT, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`list ${BUCKET} failed: ${error.message}`);
      // Entries without an id are folders; only top-level files are exports.
      return (data ?? []).filter((o) => o.id !== null).map((o) => ({ name: o.name, createdAt: o.created_at ?? null }));
    },
    download: async (name) => {
      const { data, error } = await bucket.download(name);
      if (error || !data) throw new Error(`download ${name} failed: ${error?.message ?? "no data"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    parseCsv: parse,
  });

  // A failed run is recorded in sync_run; the HTTP status only says the handler ran.
  return Response.json(result, { status: 200 });
});
