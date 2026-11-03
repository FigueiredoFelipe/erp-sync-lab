// Shared helpers for the T9 SQL tests: synthetic messages from the recorded fixtures, under test-only names,
// so nothing collides with real data in the shared local database.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ErpInvoiceDoc } from "../../src/core/adapters/erpnext/adapter.ts";
import { buildCustomerIndex, type CustomerIndex } from "../../src/core/customers/resolve.ts";
import type { CanonicalCandidate } from "../../src/core/canonical.ts";
import { decide, parseMessage, type Outcome, type RecordMessage, type RpcClient } from "../../src/services/consumer-service.ts";
import { fixtureDocs, recordMessage } from "../../src/services/test-helpers.ts";

export const TEST_PREFIX = "T9TEST-";

// The fixtures renamed to unique test names (one run id per call).
export function testDocs(): ErpInvoiceDoc[] {
  const run = randomUUID().slice(0, 8);
  return fixtureDocs().map((doc) => ({ ...doc, name: `${TEST_PREFIX}${run}-${String(doc.name)}` }));
}

export function withVersion(doc: ErpInvoiceDoc, docstatus: number, modified: string): ErpInvoiceDoc {
  return { ...structuredClone(doc), docstatus, modified };
}

// The fixtures' only customer, under the slug the shipped mapping gives it.
export function testCustomers(mappingVersion = 0): CustomerIndex {
  return buildCustomerIndex(mappingVersion, [{ source: "erpnext", matchKey: "Blue Ridge Kitchens", canonicalId: "blue-ridge-kitchens" }]);
}

export type RecordOutcome = Outcome & { candidate: CanonicalCandidate };

export function outcomeOf(doc: ErpInvoiceDoc, mappingVersion = 0): RecordOutcome {
  return decide(parseMessage(recordMessage(doc)) as RecordMessage, testCustomers(mappingVersion)) as RecordOutcome;
}

export async function send(client: pg.Client, message: unknown): Promise<string> {
  const { rows } = await client.query<{ id: string }>("select pgmq.send('invoice_events', $1::jsonb) as id", [
    JSON.stringify(message),
  ]);
  return rows[0]!.id;
}

export async function apply(client: pg.Client, outcome: Outcome, msgId: string | number): Promise<string> {
  const { rows } = await client.query<{ r: string }>("select public.apply_record($1::jsonb, $2) as r", [
    JSON.stringify(outcome),
    msgId,
  ]);
  return rows[0]!.r;
}

export async function messageExists(client: pg.Client, msgId: string): Promise<boolean> {
  const { rows } = await client.query("select 1 from pgmq.q_invoice_events where msg_id = $1", [msgId]);
  return rows.length === 1;
}

// Removes every row a committed test left for these keys.
export async function cleanup(client: pg.Client, names: string[]): Promise<void> {
  await client.query("delete from public.invoice where source = 'erpnext' and source_doc_id = any($1)", [names]);
  await client.query("delete from public.quarantine where source = 'erpnext' and source_doc_id = any($1)", [names]);
  await client.query("delete from internal.record_version where source = 'erpnext' and source_doc_id = any($1)", [names]);
}

// An RpcClient over a pg connection, calling the same public wrappers supabase-js would. With `role`, each
// call runs as that role (inside the caller's transaction) and the session returns to postgres afterwards.
export function pgRpc(client: pg.Client, role?: "service_role"): RpcClient {
  return {
    async rpc(fn, args = {}) {
      if (!/^[a-z_]+$/.test(fn)) return { data: null, error: { message: `bad function name ${fn}` } };
      const keys = Object.keys(args);
      const params = keys.map((key, i) => `${key} => $${i + 1}`).join(", ");
      const values = keys.map((key) => {
        const value = args[key];
        return typeof value === "object" && value !== null ? JSON.stringify(value) : value;
      });
      if (role) await client.query(`set local role ${role}`);
      try {
        if (fn === "read_invoice_events") {
          const { rows } = await client.query(`select * from public.${fn}(${params})`, values);
          return { data: rows, error: null };
        }
        const { rows } = await client.query(`select public.${fn}(${params}) as v`, values);
        return { data: rows[0]?.v ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } };
      } finally {
        if (role) await client.query("reset role");
      }
    },
  };
}
