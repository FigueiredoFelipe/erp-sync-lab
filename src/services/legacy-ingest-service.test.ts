import { describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { HEADER } from "../core/adapters/legacy/adapter.ts";
import {
  MAX_FILE_BYTES,
  pickNextFile,
  runLegacyIngest,
  sha256Hex,
  type LegacyIngestDeps,
  type LegacyRecordMessage,
  type RegisterResult,
  type StoredObject,
} from "./legacy-ingest-service.ts";

// T12: legacyIngestService with a fake bucket and a fake RPC. register_file's SQL is tested in tests/sql.

const DATA = join(__dirname, "..", "..", "data");
const MAIN = "unit_b_export_2026-10-16.csv";

type Call = { fn: string; args: Record<string, unknown> };

function fakeDeps(opts: {
  objects: Record<string, Uint8Array>;
  registered?: string[];
  register?: RegisterResult | Error;
  failOn?: string;
}): { deps: LegacyIngestDeps; calls: Call[]; downloads: string[] } {
  const calls: Call[] = [];
  const downloads: string[] = [];
  const deps: LegacyIngestDeps = {
    rpc: {
      rpc: async (fn, args) => {
        calls.push({ fn, args: args as Record<string, unknown> });
        if (fn === opts.failOn) return { data: null, error: { message: "boom" } };
        switch (fn) {
          case "start_sync_run":
            return { data: "run-1", error: null };
          case "unregistered_files":
            return { data: (args as { p_names: string[] }).p_names.filter((n) => !(opts.registered ?? []).includes(n)), error: null };
          case "register_file":
            if (opts.register instanceof Error) return { data: null, error: { message: opts.register.message } };
            return { data: opts.register ?? { status: "ingested", records: 0, tombstones: 0 }, error: null };
          case "finish_sync_run":
            return { data: null, error: null };
          default:
            throw new Error(`unexpected rpc ${fn}`);
        }
      },
    },
    listObjects: async () => Object.keys(opts.objects).map((name): StoredObject => ({ name, createdAt: "2026-10-18T12:00:00Z" })),
    download: async (name) => {
      downloads.push(name);
      const bytes = opts.objects[name];
      if (!bytes) throw new Error(`no object ${name}`);
      return bytes;
    },
    parseCsv: parse,
  };
  return { deps, calls, downloads };
}

const text = (s: string) => new TextEncoder().encode(s);
const fileBytes = (name: string) => new Uint8Array(readFileSync(join(DATA, name)));
const callsTo = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.args);

describe("pickNextFile", () => {
  const o = (name: string): StoredObject => ({ name, createdAt: null });

  it("takes the oldest export date, whatever the upload order", () => {
    expect(pickNextFile([o("unit_b_export_2026-10-17.csv"), o("unit_b_export_2026-10-15.csv"), o("unit_b_export_2026-10-16.csv")])?.name).toBe(
      "unit_b_export_2026-10-15.csv",
    );
  });

  it("takes undated names first, so they are rejected without blocking anything", () => {
    expect(pickNextFile([o("unit_b_export_2026-10-15.csv"), o("notes.txt")])?.name).toBe("notes.txt");
  });

  it("returns null when nothing is pending", () => {
    expect(pickNextFile([])).toBeNull();
  });
});

describe("runLegacyIngest", () => {
  it("idle: nothing unregistered -> succeeded run, no download, no register_file", async () => {
    const { deps, calls, downloads } = fakeDeps({ objects: { [MAIN]: fileBytes(MAIN) }, registered: [MAIN] });
    expect(await runLegacyIngest(deps)).toEqual({ status: "idle" });
    expect(downloads).toEqual([]);
    expect(callsTo(calls, "register_file")).toEqual([]);
    expect(callsTo(calls, "finish_sync_run")).toEqual([
      { p_id: "run-1", p_status: "succeeded", p_pages: 0, p_fetched: 0, p_enqueued: 0, p_error: null, p_fetched_docs: [] },
    ]);
  });

  it("processes one file per run, the oldest unregistered one, and sends its records", async () => {
    const newer = "unit_b_export_2026-10-17.csv";
    const { deps, calls, downloads } = fakeDeps({
      objects: { [newer]: fileBytes(newer), [MAIN]: fileBytes(MAIN) },
      register: { status: "ingested", records: 85, tombstones: 0 },
    });
    expect(await runLegacyIngest(deps)).toEqual({ objectName: MAIN, status: "ingested", records: 85, tombstones: 0 });
    expect(downloads).toEqual([MAIN]);

    const [register] = callsTo(calls, "register_file") as { p_file: Record<string, unknown>; p_records: LegacyRecordMessage[] }[];
    expect(register?.p_file).toEqual({
      objectName: MAIN,
      exportedAt: "2026-10-16",
      uploadedAt: "2026-10-18T12:00:00Z",
      contentSha256: createHash("sha256").update(fileBytes(MAIN)).digest("hex"),
      rowCount: 183,
      rejectReason: null,
    });
    expect(register?.p_records).toHaveLength(85);
    const first = register?.p_records[0] as LegacyRecordMessage;
    expect({ ...first, candidate: undefined }).toEqual({
      v: 1,
      kind: "record",
      source: "legacy_unit_b",
      sourceDocId: "UB-26001",
      sourceVersion: "2026-10-16",
      rawRef: `legacy-uploads/${MAIN}`,
      candidate: undefined,
    });
    expect(first.candidate.netTotal).toBe(882);

    expect(callsTo(calls, "finish_sync_run")).toEqual([
      {
        p_id: "run-1",
        p_status: "succeeded",
        p_pages: 1,
        p_fetched: 183,
        p_enqueued: 85,
        p_error: null,
        p_fetched_docs: [{ name: MAIN, sourceVersion: "2026-10-16", outcome: "ingested" }],
      },
    ]);
  });

  it("a whole-file rejection is registered with its reason and no records (EC07)", async () => {
    const name = "unit_b_export_2026-10-20.csv";
    const { deps, calls } = fakeDeps({
      objects: { [name]: text("INV_NO,CUSTOMER\nx,y\n") },
      register: { status: "rejected", reason: "header", records: 0, tombstones: 0 },
    });
    await runLegacyIngest(deps);
    const [register] = callsTo(calls, "register_file") as { p_file: Record<string, unknown>; p_records: unknown[] }[];
    expect(register?.p_file["rejectReason"]).toBe(`header must be exactly ${HEADER.join(",")}`);
    expect(register?.p_file["exportedAt"]).toBe("2026-10-20");
    expect(register?.p_records).toEqual([]);
    expect(callsTo(calls, "finish_sync_run")[0]?.["p_status"]).toBe("succeeded");
  });

  it("an empty file is rejected whole (AC14)", async () => {
    const name = "unit_b_export_2026-10-20.csv";
    const { deps, calls } = fakeDeps({ objects: { [name]: text("") } });
    await runLegacyIngest(deps);
    const [register] = callsTo(calls, "register_file") as { p_file: Record<string, unknown> }[];
    expect(register?.p_file["rejectReason"]).toBe("file is empty");
  });

  it("an undated name is rejected without downloading it", async () => {
    const { deps, calls, downloads } = fakeDeps({ objects: { "export.csv": text("x") } });
    await runLegacyIngest(deps);
    expect(downloads).toEqual([]);
    const [register] = callsTo(calls, "register_file") as { p_file: Record<string, unknown> }[];
    expect(register?.p_file).toMatchObject({ objectName: "export.csv", exportedAt: null, rejectReason: expect.stringMatching(/^file name must be/) });
  });

  it("a file over the size limit is rejected without parsing", async () => {
    const name = "unit_b_export_2026-10-20.csv";
    const { deps, calls } = fakeDeps({ objects: { [name]: new Uint8Array(MAX_FILE_BYTES + 1) } });
    await runLegacyIngest(deps);
    const [register] = callsTo(calls, "register_file") as { p_file: Record<string, unknown> }[];
    expect(register?.p_file["rejectReason"]).toBe(`file is larger than ${MAX_FILE_BYTES} bytes`);
  });

  it("a register_file error fails the run, records the error and doesn't throw", async () => {
    const { deps, calls } = fakeDeps({ objects: { [MAIN]: fileBytes(MAIN) }, register: new Error("deadlock") });
    expect(await runLegacyIngest(deps)).toEqual({ status: "failed", objectName: MAIN, error: "register_file failed: deadlock" });
    expect(callsTo(calls, "finish_sync_run")).toEqual([
      {
        p_id: "run-1",
        p_status: "failed",
        p_pages: 1,
        p_fetched: 183,
        p_enqueued: 0,
        p_error: "register_file failed: deadlock",
        p_fetched_docs: [{ name: MAIN, sourceVersion: "2026-10-16", outcome: "failed" }],
      },
    ]);
  });

  it("a download error fails the run", async () => {
    const { deps } = fakeDeps({ objects: { [MAIN]: fileBytes(MAIN) } });
    deps.download = async () => {
      throw new Error("storage 503");
    };
    expect(await runLegacyIngest(deps)).toMatchObject({ status: "failed", objectName: MAIN, error: "storage 503" });
  });

  it("a start_sync_run error is returned, not thrown", async () => {
    const { deps, calls } = fakeDeps({ objects: {}, failOn: "start_sync_run" });
    expect(await runLegacyIngest(deps)).toEqual({ status: "failed", error: "start_sync_run failed: boom" });
    expect(calls.map((c) => c.fn)).toEqual(["start_sync_run"]);
  });

  it("passes the same-content outcome through (EC06)", async () => {
    const { deps } = fakeDeps({
      objects: { [MAIN]: fileBytes(MAIN) },
      register: { status: "ingested", sameContentAs: "unit_b_export_2026-10-15.csv", records: 0, tombstones: 0 },
    });
    expect(await runLegacyIngest(deps)).toMatchObject({ status: "ingested", sameContentAs: "unit_b_export_2026-10-15.csv" });
  });
});

describe("sha256Hex", () => {
  it("matches Node's SHA-256", async () => {
    const bytes = text("abc");
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
