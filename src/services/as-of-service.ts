// Reads the two inputs of the BR08 as-of date from the database and applies src/core/as-of.ts.
// Runtime-agnostic: receives a supabase-js client and a clock; never reads the environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import { asOfDate, dateInZone, type AsOf, type IsoDate } from "../core/as-of.ts";
import { isMissingRelation } from "./postgrest.ts";

export interface SourceDates {
  // finished_at of the last successful ERPNext sync_run (ISO timestamp).
  erpnextLastSuccessfulSync: string | null;
  // false while public.source_file doesn't exist yet (Source B ingestion not merged).
  sourceBAvailable: boolean;
  // Newest export date of an ingested Source B file, and when the last ingest finished.
  sourceBNewestExport: IsoDate | null;
  sourceBLastSuccessfulIngest: string | null;
}

type SyncRow = { finished_at: string | null };
type FileRow = { exported_at: string | null; ingested_at: string | null };
type IngestRow = { ingested_at: string | null };

// A query that rejected (instead of returning { error }) fails the request, like a returned error.
function settledValue<T>(settled: PromiseSettledResult<T>, what: string): T {
  if (settled.status === "rejected") {
    const reason = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    throw new Error(`${what} query failed: ${reason}`);
  }
  return settled.value;
}

// The three reads go out together (R17: one round trip) and are all awaited before anything throws.
export async function readSourceDates(client: SupabaseClient): Promise<SourceDates> {
  const [syncSettled, filesSettled, ingestSettled] = await Promise.allSettled([
    client
      .from("sync_run")
      .select("finished_at")
      .eq("source", "erpnext")
      .eq("status", "succeeded")
      .order("finished_at", { ascending: false })
      .limit(1),
    client
      .from("source_file")
      .select("exported_at, ingested_at")
      .eq("status", "ingested")
      .order("exported_at", { ascending: false })
      .limit(1),
    // The last successful ingest is the latest ingested_at of any ingested file, not only the newest export.
    client
      .from("source_file")
      .select("ingested_at")
      .eq("status", "ingested")
      .not("ingested_at", "is", null)
      .order("ingested_at", { ascending: false })
      .limit(1),
  ]);

  const sync = settledValue(syncSettled, "sync_run");
  if (sync.error) throw new Error(`sync_run query failed: ${sync.error.message}`);
  const erpnextLastSuccessfulSync = ((sync.data ?? []) as SyncRow[])[0]?.finished_at ?? null;

  const files = settledValue(filesSettled, "source_file");
  if (files.error) {
    // Source B not merged yet: both source_file reads are ignored, whatever the second one returned.
    if (isMissingRelation(files.error)) {
      return { erpnextLastSuccessfulSync, sourceBAvailable: false, sourceBNewestExport: null, sourceBLastSuccessfulIngest: null };
    }
    throw new Error(`source_file query failed: ${files.error.message}`);
  }
  const newest = ((files.data ?? []) as FileRow[])[0];

  // The ingest read counts only when a file was found; with no file, its answer (or error) is ignored.
  let sourceBLastSuccessfulIngest: string | null = null;
  if (newest) {
    const ingest = settledValue(ingestSettled, "source_file");
    if (ingest.error) throw new Error(`source_file query failed: ${ingest.error.message}`);
    sourceBLastSuccessfulIngest = ((ingest.data ?? []) as IngestRow[])[0]?.ingested_at ?? null;
  }

  return {
    erpnextLastSuccessfulSync,
    sourceBAvailable: true,
    sourceBNewestExport: newest?.exported_at ? newest.exported_at.slice(0, 10) : null,
    sourceBLastSuccessfulIngest,
  };
}

export function asOfFromSourceDates(dates: SourceDates, now: Date): AsOf {
  return asOfDate({
    erpnextLastSync: dates.erpnextLastSuccessfulSync ? dateInZone(dates.erpnextLastSuccessfulSync) : null,
    sourceBNewestExport: dates.sourceBNewestExport,
    today: dateInZone(now),
  });
}

export async function readAsOf(client: SupabaseClient, now: Date): Promise<AsOf> {
  return asOfFromSourceDates(await readSourceDates(client), now);
}
