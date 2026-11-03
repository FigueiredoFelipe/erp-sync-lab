// pollService for Source A (PLAN "Source A: incremental fetch"; R01, R10, EC05, EC11, AC02, AC11).
// Runtime-agnostic: no Node or Deno APIs. The Edge Function injects the database RPC, the raw-payload
// writer and the ERPNext credentials; tests inject fakes.

import {
  ErpNextAdapter,
  cursorOf,
  deletedCursorOf,
  sourceVersionOf,
  type ErpDeletedDoc,
  type ErpInvoiceDoc,
} from "../core/adapters/erpnext/adapter.ts";
import { ErpNextHttpClient } from "../core/adapters/erpnext/http-client.ts";
import type { Clock, Cursor, RunResult, RunStatus, SyncStore } from "../core/sync/contracts.ts";
import { IncrementalSync } from "../core/sync/incremental-sync.ts";

export const SOURCE = "erpnext";
export const COMPANY = "Harvest Table Foods";

// IncrementalSync checks its 100 s budget only between fetches, so one fetch must be bounded
// (PLAN "Known limitations"): 100 s + one fetch must stay under the 150 s wall clock.
// Worst case for one fetch: attempt 1 times out (15 s) + backoff (at most 5 s, also the cap for
// Retry-After) + attempt 2 times out (15 s) = 35 s, under the ~40 s allowed. 100 + 35 = 135 s < 150 s.
export const ERP_HTTP_LIMITS = { timeoutMs: 15_000, maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 } as const;

// Raw payload writes run a few at a time: a page is up to 100 small objects.
const RAW_WRITE_CONCURRENCY = 8;

// What supabase-js's client.rpc gives back (a thenable builder), reduced to what the service needs.
export interface RpcClient {
  rpc(fn: string, args: object): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// The queue message for one invoice version. invoice-consumer (T9) relies on this exact shape.
export type RecordMessage = {
  v: 1;
  kind: "record";
  source: "erpnext";
  sourceDocId: string;
  sourceVersion: string;
  rawRef: string;
  doc: ErpInvoiceDoc;
};

export type FetchedDoc = { name: string; sourceVersion: string };

export type PollDeps = {
  rpc: RpcClient;
  putRaw: (path: string, json: string) => Promise<void>;
  erpnext: { baseUrl: string; apiKey: string; apiSecret: string };
  clock?: Clock;
  fetch?: typeof fetch; // tests only
  sleep?: (ms: number) => Promise<void>; // tests only
};

// Storage path of one document version: erpnext/<name>/<docstatus>-<fixed-width modified>.json
export function rawPathOf(doc: ErpInvoiceDoc): string {
  // sourceVersionOf is "<docstatus>|<fixed-width modified>" and validates both.
  return `erpnext/${cursorOf(doc).name}/${sourceVersionOf(doc).replace("|", "-")}.json`;
}

export function toRecordMessage(doc: ErpInvoiceDoc): RecordMessage {
  return {
    v: 1,
    kind: "record",
    source: SOURCE,
    sourceDocId: cursorOf(doc).name,
    sourceVersion: sourceVersionOf(doc),
    rawRef: rawPathOf(doc),
    doc,
  };
}

async function call(rpc: RpcClient, fn: string, args: object): Promise<unknown> {
  const { data, error } = await rpc.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------- deleted stream (EC12)

// The queue message for a deleted Sales Invoice. The consumer applies it as the cancelled outcome.
// Version "3|<creation of the Deleted Document row>" outranks every submission (1|) and cancellation (2|).
export type TombstoneMessage = {
  v: 1;
  kind: "tombstone";
  source: "erpnext";
  sourceDocId: string;
  sourceVersion: string;
  rawRef: string;
};

export function toTombstoneMessage(row: ErpDeletedDoc): TombstoneMessage {
  const deletedName = row.deleted_name;
  if (typeof deletedName !== "string" || deletedName === "") throw new Error(`Deleted Document ${row.name ?? "?"} without deleted_name`);
  return {
    v: 1,
    kind: "tombstone",
    source: SOURCE,
    sourceDocId: deletedName,
    sourceVersion: `3|${deletedCursorOf(row).modified}`,
    rawRef: `erpnext/deleted/${deletedName}.json`,
  };
}

// Business rule (BR01, EC12): which deletions can have touched the figures. A deleted draft (docstatus 0)
// never counted, and an invoice of another company was never fetched, so neither gets a tombstone; that
// also keeps a draft amendment name that ERPNext may hand out again from being tombstoned forever.
// Anything else (cancelled, unexpected docstatus, or `data` missing or unreadable) gets one: when in
// doubt, the invoice leaves the figures (fail-closed).
export function tombstoneFor(row: ErpDeletedDoc): TombstoneMessage | null {
  if (row.deleted_doctype !== undefined && row.deleted_doctype !== null && row.deleted_doctype !== "Sales Invoice") return null;
  const deleted = parseDeletedData(row.data);
  if (deleted !== null) {
    if (deleted["docstatus"] === 0) return null;
    if (typeof deleted["company"] === "string" && deleted["company"] !== COMPANY) return null;
  }
  return toTombstoneMessage(row);
}

function parseDeletedData(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stores

// Shared by both streams of one poll run: name + version of every document fetched (AC02 run log).
type RunLog = FetchedDoc[];

// Both streams run inside one sync_run, which runErpnextPoll opens and closes; so the per-stream stores
// have no-op startRun/finishRun and IncrementalSync only drives fetch, commit and cursor.
abstract class StreamStore<Doc> implements SyncStore<Doc> {
  protected readonly rpc: RpcClient;
  protected readonly putRaw: (path: string, json: string) => Promise<void>;
  protected readonly log: RunLog;
  readonly #stream: "invoices" | "deleted";

  constructor(rpc: RpcClient, putRaw: (path: string, json: string) => Promise<void>, log: RunLog, stream: "invoices" | "deleted") {
    this.rpc = rpc;
    this.putRaw = putRaw;
    this.log = log;
    this.#stream = stream;
  }

  async readCursor(): Promise<Cursor | null> {
    const rows = (await call(this.rpc, "read_sync_cursor", { p_source: SOURCE, p_stream: this.#stream })) as
      | { modified: string; name: string }[]
      | null;
    const row = rows?.[0];
    return row ? { modified: row.modified, name: row.name } : null;
  }

  abstract lastRunStatus(): Promise<RunStatus | null>;
  abstract commitPage(docs: Doc[], last: Cursor): Promise<{ enqueued: number }>;

  async startRun(): Promise<string> {
    return this.#stream;
  }

  async finishRun(): Promise<void> {}

  // Writes the raw payloads first, then enqueues and moves this stream's cursor in one transaction.
  // Raw-first means a message never points at a missing object; a rewrite is harmless.
  protected async enqueue(raws: { path: string; json: string }[], messages: object[], last: Cursor): Promise<number> {
    await forEachLimited(raws, RAW_WRITE_CONCURRENCY, (r) => this.putRaw(r.path, r.json));
    return (await call(this.rpc, "enqueue_page", {
      p_source: SOURCE,
      p_stream: this.#stream,
      p_messages: messages,
      p_last_modified: last.modified,
      p_last_name: last.name,
    })) as number;
  }
}

export class InvoiceStreamStore extends StreamStore<ErpInvoiceDoc> {
  constructor(rpc: RpcClient, putRaw: (path: string, json: string) => Promise<void>, log: RunLog) {
    super(rpc, putRaw, log, "invoices");
  }

  async lastRunStatus(): Promise<RunStatus | null> {
    return ((await call(this.rpc, "last_sync_run_status", { p_source: SOURCE })) as RunStatus | null) ?? null;
  }

  async commitPage(docs: ErpInvoiceDoc[], last: Cursor): Promise<{ enqueued: number }> {
    const messages = docs.map(toRecordMessage);
    for (const m of messages) this.log.push({ name: m.sourceDocId, sourceVersion: m.sourceVersion });
    const raws = messages.map((m) => ({ path: m.rawRef, json: JSON.stringify(m.doc) }));
    return { enqueued: await this.enqueue(raws, messages, last) };
  }
}

export class DeletedStreamStore extends StreamStore<ErpDeletedDoc> {
  constructor(rpc: RpcClient, putRaw: (path: string, json: string) => Promise<void>, log: RunLog) {
    super(rpc, putRaw, log, "deleted");
  }

  // Always re-read the overlap window: the deleted log is small, so it never needs to resume mid-backlog.
  async lastRunStatus(): Promise<RunStatus | null> {
    return null;
  }

  // Rows that need no tombstone still move the cursor (an empty message list is a valid page).
  async commitPage(rows: ErpDeletedDoc[], last: Cursor): Promise<{ enqueued: number }> {
    const pairs = rows.flatMap((row) => {
      const message = tombstoneFor(row);
      return message ? [{ row, message }] : [];
    });
    for (const { message } of pairs) this.log.push({ name: message.sourceDocId, sourceVersion: message.sourceVersion });
    const raws = pairs.map(({ row, message }) => ({ path: message.rawRef, json: JSON.stringify(row) }));
    return { enqueued: await this.enqueue(raws, pairs.map((p) => p.message), last) };
  }
}

// ---------------------------------------------------------------- one poll run

// Run budget (PLAN "Known limitations"): 100 s for both streams, checked between fetches, plus one
// bounded fetch (35 s) stays under the 150 s wall clock. The deleted stream runs first with a small cap,
// so it can never starve the invoices stream: it ends by 20 + 35 = 55 s, and the invoices stream gets
// what is left of the 100 s.
export const RUN_BUDGET_MS = 100_000;
export const DELETED_BUDGET_MS = 20_000;

// Combined status of the two streams: any failure fails the run, then any incomplete stream.
export function combineResults(results: RunResult[]): RunResult {
  const status: RunStatus = results.some((r) => r.status === "failed")
    ? "failed"
    : results.some((r) => r.status === "incomplete")
      ? "incomplete"
      : "succeeded";
  const errors = results.map((r) => r.error).filter((e): e is string => typeof e === "string");
  const combined: RunResult = {
    status,
    pages: results.reduce((n, r) => n + r.pages, 0),
    fetched: results.reduce((n, r) => n + r.fetched, 0),
    enqueued: results.reduce((n, r) => n + r.enqueued, 0),
  };
  if (errors.length > 0) combined.error = errors.join("; ");
  return combined;
}

// One poll run of Source A: the deleted stream, then the invoices stream, inside one sync_run.
// Never throws: failures end up in the RunResult and in sync_run.
export async function runErpnextPoll(deps: PollDeps): Promise<RunResult> {
  const clock = deps.clock ?? { nowMs: () => Date.now() };
  const client = new ErpNextHttpClient({
    ...deps.erpnext,
    ...ERP_HTTP_LIMITS,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const adapter = new ErpNextAdapter({ client, company: COMPANY });

  let runId: string;
  try {
    runId = (await call(deps.rpc, "start_sync_run", { p_source: SOURCE })) as string;
  } catch (error) {
    return { status: "failed", pages: 0, fetched: 0, enqueued: 0, error: error instanceof Error ? error.message : String(error) };
  }

  const log: RunLog = [];
  const startedAt = clock.nowMs();
  // Each stream fails on its own: a broken deleted stream must not stop invoices from syncing.
  const deleted = await new IncrementalSync<ErpDeletedDoc>({
    source: adapter.deletedInvoices(),
    store: new DeletedStreamStore(deps.rpc, deps.putRaw, log),
    clock,
    budgetMs: DELETED_BUDGET_MS,
  }).run();
  const invoices = await new IncrementalSync<ErpInvoiceDoc>({
    source: adapter,
    store: new InvoiceStreamStore(deps.rpc, deps.putRaw, log),
    clock,
    budgetMs: Math.max(1, RUN_BUDGET_MS - (clock.nowMs() - startedAt)),
  }).run();

  const result = combineResults([prefixError("deleted", deleted), prefixError("invoices", invoices)]);
  try {
    await call(deps.rpc, "finish_sync_run", {
      p_id: runId,
      p_status: result.status,
      p_pages: result.pages,
      p_fetched: result.fetched,
      p_enqueued: result.enqueued,
      p_error: result.error ?? null,
      p_fetched_docs: log,
    });
  } catch (error) {
    // The pages stay committed; the run row stays "running" and the next poll marks it failed.
    return { ...result, status: "failed", error: `finishRun failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return result;
}

function prefixError(stream: string, result: RunResult): RunResult {
  return result.error === undefined ? result : { ...result, error: `${stream}: ${result.error}` };
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
