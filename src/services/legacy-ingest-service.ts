// legacyIngestService for Source B (PLAN "Source B: export file ingestion"; R03, R10, BR10, EC06, EC07, AC14, AC17).
// Runtime-agnostic: no Node or Deno APIs beyond Web Crypto. The Edge Function injects the database RPC, the
// bucket listing and download, and csv-parse's `parse`; tests inject fakes.
//
// One run = at most one file: the unregistered object with the oldest export date (objects whose name carries
// no valid date go first, since they are rejected without a download). The adapter parses and groups it, and
// register_file decides older / same-content / new snapshot and enqueues in one transaction.

import type { CanonicalCandidate } from "../core/canonical.ts";
import { exportDateOf, parseFile, SOURCE, type CsvParse } from "../core/adapters/legacy/adapter.ts";

// The bucket's own limit (migration 20261018220000); checked again so a misconfigured bucket can't feed the
// parser an unbounded file.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// What supabase-js's client.rpc gives back (a thenable builder), reduced to what the service needs.
export interface RpcClient {
  rpc(fn: string, args: object): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type StoredObject = { name: string; createdAt: string | null };

export type LegacyIngestDeps = {
  rpc: RpcClient;
  listObjects: () => Promise<StoredObject[]>;
  download: (name: string) => Promise<Uint8Array>;
  parseCsv: CsvParse;
};

// Queue messages for Source B. invoice-consumer relies on these exact shapes.
export type LegacyRecordMessage = {
  v: 1;
  kind: "record";
  source: "legacy_unit_b";
  sourceDocId: string;
  sourceVersion: string; // the file's export date, YYYY-MM-DD
  rawRef: string; // legacy-uploads/<object_name>
  candidate: CanonicalCandidate;
};

// Sent by register_file (SQL), never built here; listed so the contract lives next to the record's.
export type LegacyTombstoneMessage = {
  v: 1;
  kind: "tombstone";
  source: "legacy_unit_b";
  sourceDocId: string;
  sourceVersion: string;
};

export type FileMeta = {
  objectName: string;
  exportedAt: string | null;
  uploadedAt: string | null;
  contentSha256: string | null;
  rowCount: number | null;
  rejectReason: string | null;
};

export type RegisterResult = {
  status: "ingested" | "rejected" | "already_registered";
  records: number;
  tombstones: number;
  reason?: string;
  sameContentAs?: string;
};

export type IngestResult =
  | { status: "idle" }
  | ({ objectName: string } & RegisterResult)
  | { status: "failed"; objectName?: string; error: string };

export function toRecordMessage(candidate: CanonicalCandidate): LegacyRecordMessage {
  return {
    v: 1,
    kind: "record",
    source: SOURCE,
    sourceDocId: candidate.sourceDocId,
    sourceVersion: candidate.sourceVersion,
    rawRef: candidate.rawRef,
    candidate,
  };
}

// Next object to process among the unregistered ones: undated names first (by name), then the oldest export
// date (BR10: each accepted file is newer than the one before; a late older file is then rejected whole).
export function pickNextFile(objects: StoredObject[]): StoredObject | null {
  const keyed = objects.map((o) => ({ o, date: exportDateOf(o.name) }));
  keyed.sort((a, b) => {
    if ((a.date === null) !== (b.date === null)) return a.date === null ? -1 : 1;
    if (a.date !== b.date) return (a.date ?? "") < (b.date ?? "") ? -1 : 1;
    return a.o.name < b.o.name ? -1 : a.o.name > b.o.name ? 1 : 0;
  });
  return keyed[0]?.o ?? null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function call(rpc: RpcClient, fn: string, args: object): Promise<unknown> {
  const { data, error } = await rpc.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

// One ingest run. Never throws: failures end up in the result and in sync_run.
export async function runLegacyIngest(deps: LegacyIngestDeps): Promise<IngestResult> {
  let runId: string;
  try {
    runId = (await call(deps.rpc, "start_sync_run", { p_source: SOURCE })) as string;
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  let objectName: string | undefined;
  let meta: FileMeta | null = null;
  try {
    const objects = await deps.listObjects();
    const names = objects.map((o) => o.name);
    const pending = new Set(
      names.length === 0 ? [] : (((await call(deps.rpc, "unregistered_files", { p_names: names })) as string[] | null) ?? []),
    );
    const next = pickNextFile(objects.filter((o) => pending.has(o.name)));
    if (!next) {
      await finish(deps.rpc, runId, { status: "succeeded", rows: 0, enqueued: 0, error: null, docs: [] });
      return { status: "idle" };
    }
    objectName = next.name;

    const { meta: fileMeta, records } = await prepare(deps, next);
    meta = fileMeta;
    const result = (await call(deps.rpc, "register_file", { p_file: meta, p_records: records })) as RegisterResult;

    await finish(deps.rpc, runId, {
      status: "succeeded",
      rows: meta.rowCount ?? 0,
      enqueued: result.records + result.tombstones,
      error: null,
      docs: [{ name: objectName, sourceVersion: meta.exportedAt, outcome: result.status, ...(result.reason ? { reason: result.reason } : {}) }],
    });
    return { objectName, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finish(deps.rpc, runId, {
        status: "failed",
        rows: meta?.rowCount ?? 0,
        enqueued: 0,
        error: message,
        docs: objectName ? [{ name: objectName, sourceVersion: meta?.exportedAt ?? null, outcome: "failed" }] : [],
      });
    } catch {
      // The run stays 'running'; start_sync_run marks it failed after 10 minutes.
    }
    return { status: "failed", ...(objectName ? { objectName } : {}), error: message };
  }
}

// Downloads and parses one object. Whole-file failures become a rejectReason; register_file still checks
// "older than the newest" first, so a stale file is reported as stale even when it is also malformed.
async function prepare(deps: LegacyIngestDeps, object: StoredObject): Promise<{ meta: FileMeta; records: LegacyRecordMessage[] }> {
  const exportedAt = exportDateOf(object.name);
  const base: FileMeta = {
    objectName: object.name,
    exportedAt,
    uploadedAt: object.createdAt,
    contentSha256: null,
    rowCount: null,
    rejectReason: null,
  };
  if (!exportedAt) {
    return { meta: { ...base, rejectReason: "file name must be unit_b_export_YYYY-MM-DD.csv with a real date" }, records: [] };
  }

  const bytes = await deps.download(object.name);
  const contentSha256 = await sha256Hex(bytes);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return { meta: { ...base, contentSha256, rejectReason: `file is larger than ${MAX_FILE_BYTES} bytes` }, records: [] };
  }

  const parsed = parseFile(bytes, object.name, deps.parseCsv);
  if (parsed.kind === "rejected") {
    return { meta: { ...base, contentSha256, rejectReason: parsed.reason }, records: [] };
  }
  return {
    meta: { ...base, contentSha256, rowCount: parsed.rowCount },
    records: parsed.candidates.map(toRecordMessage),
  };
}

type Finish = {
  status: "succeeded" | "failed";
  rows: number;
  enqueued: number;
  error: string | null;
  docs: object[];
};

async function finish(rpc: RpcClient, runId: string, f: Finish): Promise<void> {
  await call(rpc, "finish_sync_run", {
    p_id: runId,
    p_status: f.status,
    p_pages: f.docs.length,
    p_fetched: f.rows,
    p_enqueued: f.enqueued,
    p_error: f.error,
    p_fetched_docs: f.docs,
  });
}
