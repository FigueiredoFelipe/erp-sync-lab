// Uploads a Unit B export to the legacy-uploads bucket, as the operator would (R03). Tooling outside the
// system: uses the service role from the environment (.env, or variables set in the shell, which win).
// Never prints URLs with keys or the keys themselves.
//
//   npm run demo:upload -- data/unit_b_export_2026-10-16.csv
//   npm run demo:upload -- data/unit_b_export_2026-10-17.csv --as unit_b_export_2026-10-18.csv   (AC14: same content, newer date)
//
// The bucket is insert-only: an object name that already exists is refused, never replaced.
// legacy-ingest picks the file up within 5 minutes, or at once with: select internal.trigger_legacy_ingest();
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { BUCKET, exportDateOf } from "../../src/core/adapters/legacy/adapter.ts";

function parseArgs(argv: string[]): { file: string; objectName: string } {
  const [file, flag, as] = argv;
  if (!file || (flag !== undefined && (flag !== "--as" || !as))) {
    throw new Error("Usage: upload-unit-b.ts <file> [--as unit_b_export_YYYY-MM-DD.csv]");
  }
  return { file, objectName: as ?? basename(file) };
}

async function main(): Promise<void> {
  const { file, objectName } = parseArgs(process.argv.slice(2));
  if (!exportDateOf(objectName)) {
    // Not fatal: uploading a badly named file is how EC07's rejection is shown. Say so.
    console.warn(`Warning: ${objectName} doesn't match unit_b_export_YYYY-MM-DD.csv; legacy-ingest will reject it.`);
  }

  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const bytes = readFileSync(file);
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(objectName, bytes, { upsert: false, contentType: "text/csv" });
  if (error) throw new Error(`Upload of ${objectName} failed: ${error.message}`);
  console.log(`Uploaded ${file} as ${BUCKET}/${objectName} (${bytes.byteLength} bytes).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
