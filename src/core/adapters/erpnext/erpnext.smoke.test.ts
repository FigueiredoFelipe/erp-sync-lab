import { describe, expect, it } from "@jest/globals";
import type { Cursor } from "../../sync/contracts.ts";
import { ErpNextAdapter, type ErpInvoiceDoc } from "./adapter.ts";
import { ErpNextHttpClient } from "./http-client.ts";

// Opt-in live smoke test, GET only: ERPNEXT_SMOKE=1 node --env-file=.env ./node_modules/.bin/jest src/core/adapters/erpnext/erpnext.smoke.test.ts
// Credentials are read here (test only) and never printed.
const enabled = process.env.ERPNEXT_SMOKE === "1";

(enabled ? describe : describe.skip)("ERPNext live smoke (read-only)", () => {
  it("pages through every invoice of Harvest Table Foods in (modified, name) order", async () => {
    const client = new ErpNextHttpClient({
      baseUrl: requireEnv("ERPNEXT_URL"),
      apiKey: requireEnv("ERPNEXT_API_KEY"),
      apiSecret: requireEnv("ERPNEXT_API_SECRET"),
    });
    const adapter = new ErpNextAdapter({ client, company: "Harvest Table Foods" });

    const docs: ErpInvoiceDoc[] = [];
    let cursor: Cursor = { modified: "1900-01-01 00:00:00.000000", name: "" };
    for (let pages = 0; pages < 100; pages++) {
      const page = await adapter.fetchChangedPage(cursor, 50);
      docs.push(...page.docs);
      if (!page.last || page.docs.length < 50) break;
      expect(`${page.last.modified}|${page.last.name}` > `${cursor.modified}|${cursor.name}`).toBe(true);
      cursor = page.last;
    }

    const names = docs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(docs.filter((d) => d.docstatus === 1)).toHaveLength(196);
    expect(docs.filter((d) => d.docstatus === 2)).toHaveLength(0);
    expect(docs.every((d) => d.company === "Harvest Table Foods" && (d.items?.length ?? 0) > 0)).toBe(true);
    for (const doc of docs) expect(() => adapter.toCandidate(doc, "smoke")).not.toThrow();
  }, 120_000);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
