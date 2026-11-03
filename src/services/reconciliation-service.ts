// reconciliationService for Source A (PLAN "Reconciliation"; R14, AC05). Runtime-agnostic: the Edge
// Function injects the database RPC and the ERPNext credentials; tests inject fakes.
//
// Document by document, ERPNext's submitted invoices are compared with public.invoice. Every difference is
// classified; only `unexplained` is an alarm, so AC05 passes when a run has none.

import { ErpNextAdapter, type ErpSubmittedDoc } from "../core/adapters/erpnext/adapter.ts";
import { ErpNextHttpClient } from "../core/adapters/erpnext/http-client.ts";
import { defaultValidationConfig } from "../core/validation/validate.ts";
import { centsToDecimal, toCents } from "../core/money.ts";
import type { Cursor } from "../core/sync/contracts.ts";
import { COMPANY, ERP_HTTP_LIMITS, type RpcClient } from "./poll-service.ts";
import { reconciliationPeriod } from "../core/reconciliation/period.ts";

export type DiffClass = "in_flight" | "quarantined" | "dead_lettered" | "unexplained";

// What public.reconciliation_snapshot returns: one consistent read of the store.
export type StoreSnapshot = {
  cursor: Cursor | null; // invoices stream
  invoices: { id: string; amount: string | number; invoiceDate: string }[];
  pending: string[]; // keys with a message still in invoice_events
  quarantined: string[]; // keys in open quarantine
  deadLettered: string[]; // keys in dead_letter
};

export type ResultRow = {
  month: string; // YYYY-MM-01
  sourceDocId: string | null; // null on the month summary row
  erpAmount: string;
  storedAmount: string;
  class: DiffClass | "summary";
};

export type Reconciliation = {
  rows: ResultRow[];
  erpTotal: string;
  storedTotal: string;
  unexplained: number;
};

// Business rule (R14, AC05): why a document differs, first match wins.
// - in_flight: ERPNext changed it after the invoices cursor (the poll hasn't seen that version yet), or a
//   message for it is still queued (the consumer hasn't applied it yet);
// - quarantined: it is in open quarantine, so its absence from the figures is deliberate (principle 1);
// - dead_lettered: processing it failed 5 times (R13);
// - unexplained: anything else, the only class that is an alarm.
export function classify(
  doc: { name: string; modified: string | null },
  context: { cursor: Cursor | null; pending: ReadonlySet<string>; quarantined: ReadonlySet<string>; deadLettered: ReadonlySet<string> },
): DiffClass {
  if (context.pending.has(doc.name)) return "in_flight";
  if (doc.modified !== null && isAfterCursor(doc.modified, doc.name, context.cursor)) return "in_flight";
  if (context.quarantined.has(doc.name)) return "quarantined";
  if (context.deadLettered.has(doc.name)) return "dead_lettered";
  return "unexplained";
}

// Fixed-width `modified` strings compare as text; names break ties, like the poll's keyset.
function isAfterCursor(modified: string, name: string, cursor: Cursor | null): boolean {
  if (cursor === null) return true; // never synced: everything is still on its way
  if (modified !== cursor.modified) return modified > cursor.modified;
  return name > cursor.name;
}

const monthOf = (isoDate: string) => `${isoDate.slice(0, 7)}-01`;

// Compares ERPNext (submitted invoices in the period) with the store snapshot, in integer cents.
// A document present on one side only compares against 0 on the other.
export function reconcile(erpDocs: ErpSubmittedDoc[], snapshot: StoreSnapshot): Reconciliation {
  const context = {
    cursor: snapshot.cursor,
    pending: new Set(snapshot.pending),
    quarantined: new Set(snapshot.quarantined),
    deadLettered: new Set(snapshot.deadLettered),
  };
  const stored = new Map(snapshot.invoices.map((i) => [i.id, { cents: toCents(i.amount), month: monthOf(i.invoiceDate) }]));
  const months = new Map<string, { erp: number; stored: number }>();
  const monthTotals = (month: string) => {
    let totals = months.get(month);
    if (!totals) months.set(month, (totals = { erp: 0, stored: 0 }));
    return totals;
  };

  const rows: ResultRow[] = [];
  const seen = new Set<string>();
  for (const doc of erpDocs) {
    seen.add(doc.name);
    const erpCents = toCents(doc.baseNetTotal);
    const month = monthOf(doc.postingDate);
    monthTotals(month).erp += erpCents;
    const storedCents = stored.get(doc.name)?.cents ?? 0;
    if (stored.has(doc.name) && storedCents === erpCents) continue;
    rows.push({
      month,
      sourceDocId: doc.name,
      erpAmount: centsToDecimal(erpCents),
      storedAmount: centsToDecimal(storedCents),
      class: classify(doc, context),
    });
  }
  // Stored but not submitted in ERPNext (cancelled, deleted, or never there): its version is unknown, so
  // only a pending message, quarantine or the DLQ can explain it.
  for (const [id, s] of stored) {
    if (seen.has(id)) continue;
    if (s.cents === 0) continue; // a stored 0 matches an absent document
    rows.push({ month: s.month, sourceDocId: id, erpAmount: "0.00", storedAmount: centsToDecimal(s.cents), class: classify({ name: id, modified: null }, context) });
  }
  for (const s of stored.values()) monthTotals(s.month).stored += s.cents;

  rows.sort((a, b) => (a.month === b.month ? String(a.sourceDocId).localeCompare(String(b.sourceDocId)) : a.month < b.month ? -1 : 1));
  const summaries: ResultRow[] = [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, t]) => ({ month, sourceDocId: null, erpAmount: centsToDecimal(t.erp), storedAmount: centsToDecimal(t.stored), class: "summary" }));

  const erpTotal = [...months.values()].reduce((n, t) => n + t.erp, 0);
  const storedTotal = [...months.values()].reduce((n, t) => n + t.stored, 0);
  return {
    rows: [...summaries, ...rows],
    erpTotal: centsToDecimal(erpTotal),
    storedTotal: centsToDecimal(storedTotal),
    unexplained: rows.filter((r) => r.class === "unexplained").length,
  };
}

// The period a run covers by default, the validation period (BR03). The Sync health page and the freshness
// service read it too, so the period on screen and the period of the run can't drift (R20).
export { reconciliationPeriod };

export type ReconcileDeps = {
  rpc: RpcClient;
  erpnext: { baseUrl: string; apiKey: string; apiSecret: string };
  period?: { from: string; to: string }; // default: the validation period (BR03)
  fetch?: typeof fetch; // tests only
  sleep?: (ms: number) => Promise<void>; // tests only
};

export type ReconcileResult = {
  runId: string;
  status: "succeeded" | "failed";
  erpTotal: string | null;
  storedTotal: string | null;
  unexplained: number | null;
  differences: number;
  error?: string;
};

async function call(rpc: RpcClient, fn: string, args: object): Promise<unknown> {
  const { data, error } = await rpc.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

// One reconciliation run. Throws only if the run can't be opened or closed; any other failure is recorded
// as a failed run.
export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileResult> {
  const period = deps.period ?? reconciliationPeriod();
  const runId = (await call(deps.rpc, "start_reconciliation_run", {})) as string;

  let outcome: Omit<ReconcileResult, "runId">;
  let results: ResultRow[] = [];
  try {
    // Snapshot first, then ERPNext: a document that changes in between is newer than the snapshot's
    // cursor (or still queued), so it is classified in_flight, never unexplained.
    const snapshot = (await call(deps.rpc, "reconciliation_snapshot", { p_from: period.from, p_to: period.to })) as StoreSnapshot;
    const client = new ErpNextHttpClient({
      ...deps.erpnext,
      ...ERP_HTTP_LIMITS,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const erpDocs = await new ErpNextAdapter({ client, company: COMPANY }).fetchSubmittedDocuments(COMPANY, period.from, period.to);
    const r = reconcile(erpDocs, snapshot);
    results = r.rows;
    outcome = {
      status: "succeeded",
      erpTotal: r.erpTotal,
      storedTotal: r.storedTotal,
      unexplained: r.unexplained,
      differences: r.rows.filter((row) => row.class !== "summary").length,
    };
  } catch (error) {
    outcome = { status: "failed", erpTotal: null, storedTotal: null, unexplained: null, differences: 0, error: error instanceof Error ? error.message : String(error) };
  }

  await call(deps.rpc, "finish_reconciliation_run", {
    p_id: runId,
    p_status: outcome.status,
    p_erp_total: outcome.erpTotal,
    p_stored_total: outcome.storedTotal,
    p_unexplained: outcome.unexplained,
    p_error: outcome.error ?? null,
    p_results: results,
  });
  return { runId, ...outcome };
}
