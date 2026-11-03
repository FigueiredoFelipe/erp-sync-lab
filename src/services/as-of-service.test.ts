import { describe, expect, it } from "@jest/globals";
import { fakeSupabase, issuedNames, type Result, type Results } from "../../tests/http/fake-supabase.ts";
import { readSourceDates } from "./as-of-service.ts";

const SYNC_RUN: Result = { data: [{ finished_at: "2026-10-18T18:00:00+00:00" }], error: null };
const MISSING: Result = { data: null, error: { message: "Could not find the table 'public.source_file' in the schema cache", code: "PGRST205" } };
const TIMEOUT: Result = { data: null, error: { message: "timeout" } };
// source_file is read twice: [newest export, latest ingest].
const FILE_PRESENT: Result[] = [
  { data: [{ exported_at: "2026-10-17", ingested_at: "2026-10-17T09:00:00Z" }], error: null },
  { data: [{ ingested_at: "2026-10-18T12:00:00Z" }], error: null },
];

function read(sourceFile: Results, syncRun: Results = SYNC_RUN) {
  const fake = fakeSupabase({ sync_run: syncRun, source_file: sourceFile });
  return { promise: readSourceDates(fake.client), calls: fake.calls };
}

describe("readSourceDates", () => {
  it("reads the last ERPNext sync, the newest export and the latest ingest", async () => {
    const { promise, calls } = read(FILE_PRESENT);
    expect(await promise).toEqual({
      erpnextLastSuccessfulSync: "2026-10-18T18:00:00+00:00",
      sourceBAvailable: true,
      sourceBNewestExport: "2026-10-17",
      // From the third read: the latest ingest of any file, not the newest export's.
      sourceBLastSuccessfulIngest: "2026-10-18T12:00:00Z",
    });
    expect(calls.map((c) => c.chain)).toEqual([
      [["select", "finished_at"], ["eq", "source", "erpnext"], ["eq", "status", "succeeded"], ["order", "finished_at", { ascending: false }], ["limit", 1]],
      [["select", "exported_at, ingested_at"], ["eq", "status", "ingested"], ["order", "exported_at", { ascending: false }], ["limit", 1]],
      [
        ["select", "ingested_at"],
        ["eq", "status", "ingested"],
        ["not", "ingested_at", "is", null],
        ["order", "ingested_at", { ascending: false }],
        ["limit", 1],
      ],
    ]);
  });

  it("reports Source B as not available while source_file doesn't exist, ignoring both of its reads", async () => {
    for (const sourceFile of [MISSING, [MISSING, TIMEOUT]]) {
      expect(await read(sourceFile).promise).toEqual({
        erpnextLastSuccessfulSync: "2026-10-18T18:00:00+00:00",
        sourceBAvailable: false,
        sourceBNewestExport: null,
        sourceBLastSuccessfulIngest: null,
      });
    }
  });

  it("ignores the ingest read, even its error, when no file has been ingested", async () => {
    for (const sourceFile of [{ data: [], error: null }, [{ data: [], error: null }, TIMEOUT]] as Results[]) {
      expect(await read(sourceFile, { data: [], error: null }).promise).toEqual({
        erpnextLastSuccessfulSync: null,
        sourceBAvailable: true,
        sourceBNewestExport: null,
        sourceBLastSuccessfulIngest: null,
      });
    }
  });

  it.each([
    ["sync_run", FILE_PRESENT, TIMEOUT, "sync_run query failed: timeout"],
    ["sync_run, even with source_file missing", MISSING, TIMEOUT, "sync_run query failed: timeout"],
    ["the newest-export read", [TIMEOUT, FILE_PRESENT[1]!], SYNC_RUN, "source_file query failed: timeout"],
    ["the ingest read, when a file exists", [FILE_PRESENT[0]!, TIMEOUT], SYNC_RUN, "source_file query failed: timeout"],
  ] as [string, Results, Result, string][])("throws when %s fails", async (_name, sourceFile, syncRun, message) => {
    await expect(read(sourceFile, syncRun).promise).rejects.toThrow(message);
  });

  // Makes the n-th query on `table` (0-based, in creation order) reject when awaited, instead of returning { error }.
  function rejectingRead(fake: ReturnType<typeof fakeSupabase>, table: string, nth: number) {
    const from = fake.client.from.bind(fake.client);
    let n = 0;
    const rejecting = (): unknown =>
      new Proxy(
        { then: (resolve: unknown, reject: (reason: unknown) => unknown) => Promise.reject(new Error("fetch failed")).then(resolve as never, reject) },
        { get: (target, prop) => (prop === "then" ? target.then : () => rejecting()) },
      );
    (fake.client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t !== table) return from(t);
      return n++ === nth ? rejecting() : from(t);
    };
  }

  it("ignores a rejected ingest read when no file has been ingested", async () => {
    const fake = fakeSupabase({ sync_run: SYNC_RUN, source_file: { data: [], error: null } });
    rejectingRead(fake, "source_file", 1);
    expect(await readSourceDates(fake.client)).toEqual({
      erpnextLastSuccessfulSync: "2026-10-18T18:00:00+00:00",
      sourceBAvailable: true,
      sourceBNewestExport: null,
      sourceBLastSuccessfulIngest: null,
    });
  });

  it("throws when the ingest read rejects and a file exists", async () => {
    const fake = fakeSupabase({ sync_run: SYNC_RUN, source_file: FILE_PRESENT });
    rejectingRead(fake, "source_file", 1);
    await expect(readSourceDates(fake.client)).rejects.toThrow("source_file query failed: fetch failed");
  });

  it("throws when the newest-export read rejects", async () => {
    const fake = fakeSupabase({ sync_run: SYNC_RUN, source_file: FILE_PRESENT });
    rejectingRead(fake, "source_file", 0);
    await expect(readSourceDates(fake.client)).rejects.toThrow("source_file query failed: fetch failed");
  });

  it("throws when a read rejects instead of returning an error", async () => {
    const fake = fakeSupabase({ sync_run: SYNC_RUN, source_file: FILE_PRESENT });
    const from = fake.client.from.bind(fake.client);
    (fake.client as unknown as { from: (table: string) => unknown }).from = (table: string) =>
      table === "sync_run" ? { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.reject(new Error("fetch failed")) }) }) }) }) } : from(table);
    await expect(readSourceDates(fake.client)).rejects.toThrow("sync_run query failed: fetch failed");
  });

  it("issues the three reads in one round trip", async () => {
    const fake = fakeSupabase({ sync_run: SYNC_RUN, source_file: FILE_PRESENT }, {}, { deferred: true });
    const promise = readSourceDates(fake.client);
    await fake.settle();
    expect(issuedNames(fake)).toEqual(["source_file", "source_file", "sync_run"]);
    fake.releaseAll();
    expect((await promise).sourceBLastSuccessfulIngest).toBe("2026-10-18T12:00:00Z");
  });

  it("waits for every read before throwing", async () => {
    const fake = fakeSupabase({ sync_run: TIMEOUT, source_file: FILE_PRESENT }, {}, { deferred: true });
    let settled = false;
    const promise = readSourceDates(fake.client).finally(() => {
      settled = true;
    });
    await fake.settle();
    fake.release("sync_run");
    await fake.settle();
    expect(settled).toBe(false);
    fake.releaseAll();
    await expect(promise).rejects.toThrow("sync_run query failed");
  });
});
