// Copies the live figures once into app/demo/snapshot.json for the public /demo page (src/demo/snapshot.ts).
// Read only: it calls the same services the dashboard uses, with the service-role key, and writes nothing to the
// database. Refuses to write the file if anything in it matches LEAK_PATTERN.
//
//   npm run demo:snapshot
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LEAK_PATTERN, toDemoSnapshot } from "../../src/demo/snapshot.ts";
import { createCustomerRevenueService } from "../../src/services/customer-revenue-service.ts";
import { createFreshnessService } from "../../src/services/freshness-service.ts";
import { createQuarantineService } from "../../src/services/quarantine-service.ts";
import { createRevenueService } from "../../src/services/revenue-service.ts";

const RANGE = { from: "2026-01", to: "2026-10" } as const;
const OUT = new URL("../../app/demo/snapshot.json", import.meta.url);

async function main(): Promise<void> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const client = createClient(url, key, { auth: { persistSession: false } }) as unknown as SupabaseClient;

  const [monthly, customers, quarantine, freshness] = await Promise.all([
    createRevenueService(client).getMonthlyRevenue(RANGE),
    createCustomerRevenueService(client).getCustomerRevenue({ range: RANGE, source: null, customer: null }),
    createQuarantineService(client).listOpen({ source: null, reason: null }),
    createFreshnessService(client, { testSwitchesEnabled: false }).getFreshness(),
  ]);

  const snapshot = toDemoSnapshot({ generatedAt: new Date().toISOString(), monthly, customers, quarantine, freshness });
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (LEAK_PATTERN.test(text)) throw new Error("The snapshot matches LEAK_PATTERN; nothing was written");
  await writeFile(OUT, text);
  console.log(`Wrote ${OUT.pathname}: ${snapshot.total.invoices} invoices, ${snapshot.total.totalCents} cents`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
