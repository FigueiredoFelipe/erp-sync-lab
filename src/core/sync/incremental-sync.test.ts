import { describe, expect, it } from "@jest/globals";
import {
  SourceUnavailableError,
  type ChangeSource,
  type ChangedPage,
  type Clock,
  type Cursor,
  type RunResult,
  type RunStatus,
  type SyncStore,
} from "./contracts.ts";
import { IncrementalSync } from "./incremental-sync.ts";

// Behaviour contract for IncrementalSync (T4). The class is implemented by hand against it (T5).

type TestDoc = { name: string; modified: string; postingDate?: string };

const BEGINNING: Cursor = { modified: "0001-01-01 00:00:00.000000", name: "" };

// (modified, name) order. Fixed-width strings compare correctly as plain strings.
function compareCursor(a: Cursor, b: Cursor): number {
  if (a.modified !== b.modified) return a.modified < b.modified ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

function doc(name: string, modified: string, postingDate?: string): TestDoc {
  return postingDate === undefined ? { name, modified } : { name, modified, postingDate };
}

// Docs SINV-0001..SINV-000n, one second apart, starting at 2026-10-18 09:00:01.
function docsOneSecondApart(count: number): TestDoc[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return doc(`SINV-${String(n).padStart(4, "0")}`, `2026-10-18 09:00:${String(n).padStart(2, "0")}.000000`);
  });
}

// Shared log so tests can assert the order of fetches and commits.
type Event = "fetch" | "commit";

class FakeClock implements Clock {
  #now = 1_000_000;
  readonly msPerFetch: number;

  constructor(msPerFetch = 0) {
    this.msPerFetch = msPerFetch;
  }

  nowMs(): number {
    return this.#now;
  }

  tickFetch(): void {
    this.#now += this.msPerFetch;
  }
}

type FetchCall = { after: Cursor; limit: number };

// Source A over an in-memory list: returns docs strictly after `after` in (modified, name) order.
class FakeSource implements ChangeSource<TestDoc> {
  readonly calls: FetchCall[] = [];
  readonly #docs: TestDoc[];
  readonly #clock: FakeClock;
  readonly #events: Event[];
  #failOnCall: number | null = null;
  #failWith: Error | null = null;

  constructor(docs: TestDoc[], clock: FakeClock, events: Event[]) {
    this.#docs = [...docs].sort(compareCursor);
    this.#clock = clock;
    this.#events = events;
  }

  // The Nth call (1-based) throws `error` instead of returning a page.
  failOnCall(n: number, error: Error): void {
    this.#failOnCall = n;
    this.#failWith = error;
  }

  async fetchChangedPage(after: Cursor, limit: number): Promise<ChangedPage<TestDoc>> {
    this.calls.push({ after: { ...after }, limit });
    this.#events.push("fetch");
    this.#clock.tickFetch();
    if (this.#failOnCall === this.calls.length && this.#failWith !== null) throw this.#failWith;
    const docs = this.#docs.filter((d) => compareCursor(d, after) > 0).slice(0, limit);
    const lastDoc = docs.at(-1);
    return { docs, last: lastDoc === undefined ? null : { modified: lastDoc.modified, name: lastDoc.name } };
  }
}

type CommitCall = { docs: TestDoc[]; last: Cursor };

// Mirrors internal.enqueue_page: skips docs already enqueued at that version (name + modified)
// and moves the cursor forward only.
class FakeStore implements SyncStore<TestDoc> {
  cursor: Cursor | null;
  readonly commits: CommitCall[] = [];
  readonly enqueued: TestDoc[] = [];
  readonly startedRuns: string[] = [];
  readonly finishedRuns: { runId: string; result: RunResult }[] = [];
  readonly #enqueuedKeys = new Set<string>();
  readonly #events: Event[];
  #commitError: Error | null = null;
  previousStatus: RunStatus | null = null;

  constructor(events: Event[], cursor: Cursor | null = null, alreadyEnqueued: TestDoc[] = []) {
    this.#events = events;
    this.cursor = cursor;
    for (const d of alreadyEnqueued) this.#enqueuedKeys.add(`${d.name}@${d.modified}`);
  }

  failCommitWith(error: Error): void {
    this.#commitError = error;
  }

  async readCursor(): Promise<Cursor | null> {
    return this.cursor === null ? null : { ...this.cursor };
  }

  async commitPage(docs: TestDoc[], last: Cursor): Promise<{ enqueued: number }> {
    this.#events.push("commit");
    if (this.#commitError !== null) throw this.#commitError;
    this.commits.push({ docs: [...docs], last: { ...last } });
    let enqueued = 0;
    for (const d of docs) {
      const key = `${d.name}@${d.modified}`;
      if (this.#enqueuedKeys.has(key)) continue;
      this.#enqueuedKeys.add(key);
      this.enqueued.push(d);
      enqueued++;
    }
    if (this.cursor === null || compareCursor(last, this.cursor) > 0) this.cursor = { ...last };
    return { enqueued };
  }

  async lastRunStatus(): Promise<RunStatus | null> {
    return this.finishedRuns.at(-1)?.result.status ?? this.previousStatus;
  }

  async startRun(): Promise<string> {
    const runId = `run-${this.startedRuns.length + 1}`;
    this.startedRuns.push(runId);
    return runId;
  }

  async finishRun(runId: string, result: RunResult): Promise<void> {
    this.finishedRuns.push({ runId, result });
  }
}

type Setup = {
  docs?: TestDoc[];
  cursor?: Cursor | null;
  alreadyEnqueued?: TestDoc[];
  pageSize?: number;
  msPerFetch?: number;
};

function setup({ docs = [], cursor = null, alreadyEnqueued = [], pageSize, msPerFetch = 0 }: Setup = {}) {
  const events: Event[] = [];
  const clock = new FakeClock(msPerFetch);
  const source = new FakeSource(docs, clock, events);
  const store = new FakeStore(events, cursor, alreadyEnqueued);
  const sync =
    pageSize === undefined
      ? new IncrementalSync<TestDoc>({ source, store, clock })
      : new IncrementalSync<TestDoc>({ source, store, clock, pageSize });
  return { events, clock, source, store, sync };
}

function names(docs: TestDoc[]): string[] {
  return docs.map((d) => d.name);
}

describe("IncrementalSync", () => {
  describe("starting point", () => {
    it("with no stored cursor, fetches from the beginning and commits every doc once (succeeded)", async () => {
      const docs = docsOneSecondApart(3);
      const { source, store, sync } = setup({ docs });

      const result = await sync.run();

      expect(source.calls[0]).toEqual({ after: BEGINNING, limit: 100 });
      expect(names(store.enqueued)).toEqual(["SINV-0001", "SINV-0002", "SINV-0003"]);
      expect(store.cursor).toEqual({ modified: "2026-10-18 09:00:03.000000", name: "SINV-0003" });
      expect(result).toEqual({ status: "succeeded", pages: 1, fetched: 3, enqueued: 3 });
    });

    it.each([
      ["same day", "2026-10-18 12:00:00.000000", "2026-10-18 10:55:00.000000"],
      ["across midnight, keeping microseconds", "2026-10-18 00:30:00.123456", "2026-10-17 23:25:00.123456"],
      ["across a month boundary", "2026-10-01 00:10:00.000000", "2026-09-30 23:05:00.000000"],
      ["across February in a non-leap year", "2026-03-01 01:00:00.000000", "2026-02-28 23:55:00.000000"],
      ["across a year boundary", "2027-01-01 00:00:00.000000", "2026-12-31 22:55:00.000000"],
    ])("with a stored cursor, starts 65 minutes before it with an empty name (%s)", async (_case, cursorModified, expectedAfter) => {
      const { source, sync } = setup({ cursor: { modified: cursorModified, name: "SINV-0042" } });

      await sync.run();

      expect(source.calls[0]).toEqual({ after: { modified: expectedAfter, name: "" }, limit: 100 });
    });

    it("re-reads docs inside the overlap window but not docs older than it", async () => {
      const cursor = { modified: "2026-10-18 12:00:00.000000", name: "SINV-0003" };
      const tooOld = doc("SINV-0001", "2026-10-18 10:54:59.999999");
      const inWindow = doc("SINV-0002", "2026-10-18 10:55:00.000000");
      const atCursor = doc("SINV-0003", "2026-10-18 12:00:00.000000");
      const { store, sync } = setup({ docs: [tooOld, inWindow, atCursor], cursor, alreadyEnqueued: [tooOld, inWindow, atCursor] });

      const result = await sync.run();

      expect(store.commits.flatMap((c) => names(c.docs))).toEqual(["SINV-0002", "SINV-0003"]);
      expect(result).toEqual({ status: "succeeded", pages: 1, fetched: 2, enqueued: 0 });
    });
  });

  describe("pagination", () => {
    it("starts each fetch after the previous page's last doc and commits each page before the next fetch", async () => {
      const docs = docsOneSecondApart(5);
      const { events, source, store, sync } = setup({ docs, pageSize: 2 });

      await sync.run();

      expect(source.calls).toEqual([
        { after: BEGINNING, limit: 2 },
        { after: { modified: "2026-10-18 09:00:02.000000", name: "SINV-0002" }, limit: 2 },
        { after: { modified: "2026-10-18 09:00:04.000000", name: "SINV-0004" }, limit: 2 },
      ]);
      expect(store.commits.map((c) => c.last.name)).toEqual(["SINV-0002", "SINV-0004", "SINV-0005"]);
      expect(events).toEqual(["fetch", "commit", "fetch", "commit", "fetch", "commit"]);
    });

    it("ends as succeeded when a page is shorter than pageSize", async () => {
      const { source, sync } = setup({ docs: docsOneSecondApart(3), pageSize: 2 });

      const result = await sync.run();

      expect(source.calls).toHaveLength(2);
      expect(result).toEqual({ status: "succeeded", pages: 2, fetched: 3, enqueued: 3 });
    });

    it("fetches one more (empty) page when the last page is exactly full, and commits nothing for it", async () => {
      const { source, store, sync } = setup({ docs: docsOneSecondApart(4), pageSize: 2 });

      const result = await sync.run();

      expect(source.calls).toHaveLength(3);
      expect(store.commits).toHaveLength(2);
      expect(result).toEqual({ status: "succeeded", pages: 2, fetched: 4, enqueued: 4 });
    });

    it("ends as succeeded with 0 fetched when the first page is empty, without committing", async () => {
      const cursor = { modified: "2026-10-18 12:00:00.000000", name: "SINV-0009" };
      const { store, sync } = setup({ cursor });

      const result = await sync.run();

      expect(store.commits).toHaveLength(0);
      expect(store.cursor).toEqual(cursor);
      expect(result).toEqual({ status: "succeeded", pages: 0, fetched: 0, enqueued: 0 });
    });

    it("skips no doc and commits none twice when several docs share a modified across page boundaries (EC03)", async () => {
      const same = "2026-10-18 10:00:00.000000";
      const docs = ["SINV-0001", "SINV-0002", "SINV-0003", "SINV-0004", "SINV-0005"].map((n) => doc(n, same));
      const { source, store, sync } = setup({ docs, pageSize: 2 });

      const result = await sync.run();

      expect(source.calls.map((c) => c.after)).toEqual([
        BEGINNING,
        { modified: same, name: "SINV-0002" },
        { modified: same, name: "SINV-0004" },
      ]);
      const committed = store.commits.flatMap((c) => names(c.docs));
      expect(committed).toEqual(["SINV-0001", "SINV-0002", "SINV-0003", "SINV-0004", "SINV-0005"]);
      expect(result).toEqual({ status: "succeeded", pages: 3, fetched: 5, enqueued: 5 });
    });
  });

  describe("failures", () => {
    it("returns failed without throwing when the source is unavailable on page 2, leaving the cursor at page 1's last (EC05)", async () => {
      const { source, store, sync } = setup({ docs: docsOneSecondApart(5), pageSize: 2 });
      source.failOnCall(2, new SourceUnavailableError("ERPNext returned 502 after retries"));

      const result = await sync.run();

      expect(result).toEqual({
        status: "failed",
        pages: 1,
        fetched: 2,
        enqueued: 2,
        error: "ERPNext returned 502 after retries",
      });
      expect(store.cursor).toEqual({ modified: "2026-10-18 09:00:02.000000", name: "SINV-0002" });
      expect(store.finishedRuns).toEqual([{ runId: "run-1", result }]);
    });

    it("returns failed without throwing on an unexpected error from the source", async () => {
      const { source, store, sync } = setup({ docs: docsOneSecondApart(3) });
      source.failOnCall(1, new Error("unexpected response shape"));

      const result = await sync.run();

      expect(result).toEqual({ status: "failed", pages: 0, fetched: 0, enqueued: 0, error: "unexpected response shape" });
      expect(store.cursor).toBeNull();
      expect(store.finishedRuns).toEqual([{ runId: "run-1", result }]);
    });

    it("returns failed and reports the error to finishRun when the store throws", async () => {
      const { store, sync } = setup({ docs: docsOneSecondApart(3) });
      store.failCommitWith(new Error("connection reset"));

      const result = await sync.run();

      expect(result.status).toBe("failed");
      expect(result.error).toBe("connection reset");
      expect(store.finishedRuns).toHaveLength(1);
      expect(store.finishedRuns[0]?.result).toEqual(result);
    });
  });

  describe("time budget", () => {
    it("stops before fetching another page once elapsed time reaches 100 000 ms (incomplete), and the next run continues with no gap", async () => {
      const docs = docsOneSecondApart(10);
      // Each fetch takes 50 s: after page 2 the elapsed time is exactly 100 000 ms.
      const first = setup({ docs, pageSize: 2, msPerFetch: 50_000 });

      const firstResult = await first.sync.run();

      expect(first.source.calls).toHaveLength(2);
      expect(firstResult).toEqual({ status: "incomplete", pages: 2, fetched: 4, enqueued: 4 });
      expect(first.store.cursor).toEqual({ modified: "2026-10-18 09:00:04.000000", name: "SINV-0004" });

      // Next run: same store (cursor and enqueued docs carry over), no time pressure.
      const events: Event[] = [];
      const clock = new FakeClock(0);
      const source = new FakeSource(docs, clock, events);
      const secondResult = await new IncrementalSync<TestDoc>({ source, store: first.store, clock, pageSize: 2 }).run();

      // After an incomplete run the cursor is mid-backlog: resume exactly there, with no overlap.
      expect(source.calls[0]?.after).toEqual({ modified: "2026-10-18 09:00:04.000000", name: "SINV-0004" });
      expect(secondResult.status).toBe("succeeded");
      expect(secondResult.enqueued).toBe(6);
      expect(names(first.store.enqueued)).toEqual(names(docs));
      expect(first.store.cursor).toEqual({ modified: "2026-10-18 09:00:10.000000", name: "SINV-0010" });
    });

    it("keeps fetching while elapsed time is below the budget", async () => {
      // 40 s per fetch: checks at 40 s and 80 s pass, the check at 120 s stops the run.
      const { source, sync } = setup({ docs: docsOneSecondApart(10), pageSize: 2, msPerFetch: 40_000 });

      const result = await sync.run();

      expect(source.calls).toHaveLength(3);
      expect(result).toEqual({ status: "incomplete", pages: 3, fetched: 6, enqueued: 6 });
    });
  });

  describe("cursor", () => {
    it("never moves back when the overlap window re-reads only docs already behind the cursor", async () => {
      const cursor = { modified: "2026-10-18 12:00:00.000000", name: "SINV-0003" };
      const docs = [
        doc("SINV-0001", "2026-10-18 11:30:00.000000"),
        doc("SINV-0002", "2026-10-18 11:45:00.000000"),
        doc("SINV-0003", "2026-10-18 12:00:00.000000"),
      ];
      const { store, sync } = setup({ docs, cursor, alreadyEnqueued: docs });

      const result = await sync.run();

      expect(store.cursor).toEqual(cursor);
      expect(result).toEqual({ status: "succeeded", pages: 1, fetched: 3, enqueued: 0 });
    });

    it("fetches a late invoice whose modified is after the cursor, whatever its posting date (EC11)", async () => {
      const cursor = { modified: "2026-10-18 12:00:00.000000", name: "SINV-0003" };
      const old = doc("SINV-0001", "2026-10-17 08:00:00.000000", "2026-10-17");
      const late = doc("SINV-0099", "2026-10-18 12:30:00.000000", "2026-08-15");
      const { store, sync } = setup({ docs: [old, late], cursor, alreadyEnqueued: [old] });

      const result = await sync.run();

      expect(store.enqueued).toEqual([late]);
      expect(store.cursor).toEqual({ modified: late.modified, name: late.name });
      expect(result).toEqual({ status: "succeeded", pages: 1, fetched: 1, enqueued: 1 });
    });
  });

  describe("run bookkeeping", () => {
    it("calls startRun and finishRun exactly once and reports pages, fetched and enqueued", async () => {
      const docs = docsOneSecondApart(5);
      // SINV-0001 and SINV-0002 were enqueued by an earlier run at the same version.
      const { store, sync } = setup({ docs, pageSize: 2, alreadyEnqueued: docs.slice(0, 2) });

      const result = await sync.run();

      expect(store.startedRuns).toEqual(["run-1"]);
      expect(store.finishedRuns).toEqual([{ runId: "run-1", result }]);
      expect(result).toEqual({ status: "succeeded", pages: 3, fetched: 5, enqueued: 3 });
    });
  });

  describe("review findings (2026-10-18)", () => {
    it("does not livelock when the backlog inside the overlap window is larger than one run", async () => {
      // 12 docs in the same minute, 2 per page, 50 s per fetch: each run commits 2 pages, then stops.
      const docs = Array.from({ length: 12 }, (_, i) => doc(`SINV-${String(i + 1).padStart(4, "0")}`, "2026-10-18 09:00:00.000000"));
      const { store, clock } = setup({ docs, pageSize: 2, msPerFetch: 50_000 });
      store.cursor = { modified: "2026-10-18 09:00:00.000000", name: "" };
      for (let run = 0; run < 3; run++) {
        const source = new FakeSource(docs, clock, []);
        await new IncrementalSync<TestDoc>({ source, store, clock, pageSize: 2 }).run();
      }
      expect(store.finishedRuns.map((r) => r.result.status)).toEqual(["incomplete", "incomplete", "incomplete"]);
      expect(store.enqueued).toHaveLength(12);
    });

    it("applies the overlap again after a failed run", async () => {
      const { store, source, sync } = setup({ cursor: { modified: "2026-10-18 10:00:00.000000", name: "SINV-0001" } });
      store.previousStatus = "failed";
      await sync.run();
      expect(source.calls[0]?.after).toEqual({ modified: "2026-10-18 08:55:00.000000", name: "" });
    });

    it("accepts a stored cursor with fewer than 6 fractional digits", async () => {
      const { source, sync } = setup({ cursor: { modified: "2026-10-18 10:00:00", name: "SINV-0001" } });
      await sync.run();
      expect(source.calls[0]?.after).toEqual({ modified: "2026-10-18 08:55:00.000000", name: "" });
    });

    it("fails instead of spinning when a full page does not advance", async () => {
      const stuck: ChangeSource<TestDoc> = {
        fetchChangedPage: async () => ({ docs: [doc("SINV-0001", "2026-10-18 09:00:00.000000")], last: { modified: "0001-01-01 00:00:00.000000", name: "" } }),
      };
      const { store, clock } = setup();
      const result = await new IncrementalSync<TestDoc>({ source: stuck, store, clock, pageSize: 1 }).run();
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/does not advance/);
    });

    it("never throws when startRun or finishRun fails", async () => {
      const { store, source, clock } = setup({ docs: docsOneSecondApart(1) });
      const failingStart = Object.assign(Object.create(store), { startRun: async () => { throw new Error("db down"); } });
      await expect(new IncrementalSync<TestDoc>({ source, store: failingStart, clock }).run()).resolves.toMatchObject({ status: "failed", error: "db down" });
      const failingFinish = Object.assign(Object.create(store), { finishRun: async () => { throw new Error("db gone"); } });
      await expect(new IncrementalSync<TestDoc>({ source, store: failingFinish, clock }).run()).resolves.toMatchObject({ status: "failed", error: "finishRun failed: db gone" });
    });

    it("fails without fetching when readCursor throws, instead of resyncing from the beginning", async () => {
      const { store, source, clock } = setup({ docs: docsOneSecondApart(3) });
      const broken = Object.assign(Object.create(store), { readCursor: async () => { throw new Error("cursor unreadable"); } });
      const result = await new IncrementalSync<TestDoc>({ source, store: broken, clock }).run();
      expect(result).toEqual({ status: "failed", pages: 0, fetched: 0, enqueued: 0, error: "cursor unreadable" });
      expect(source.calls).toHaveLength(0);
      expect(store.finishedRuns).toHaveLength(1);
    });

    it("fails on a malformed stored cursor", async () => {
      const { source, sync } = setup({ cursor: { modified: "18/10/2026 10:00", name: "SINV-0001" } });
      const result = await sync.run();
      expect(result.status).toBe("failed");
      expect(source.calls).toHaveLength(0);
    });

    it("recovers on the next run after a failed run (AC11)", async () => {
      const docs = docsOneSecondApart(5);
      const first = setup({ docs, pageSize: 2 });
      first.source.failOnCall(2, new SourceUnavailableError("ERPNext returned 502"));
      expect((await first.sync.run()).status).toBe("failed");
      const second = new IncrementalSync<TestDoc>({ source: new FakeSource(docs, first.clock, []), store: first.store, clock: first.clock, pageSize: 2 });
      expect((await second.run()).status).toBe("succeeded");
      expect(names(first.store.enqueued)).toEqual(names(docs));
      expect(first.store.cursor).toEqual({ modified: docs[4]!.modified, name: docs[4]!.name });
    });

    it("enqueues nothing and keeps the cursor when run twice with no changes (AC01)", async () => {
      const docs = docsOneSecondApart(3);
      const { store, clock, sync } = setup({ docs });
      await sync.run();
      const cursorAfterFirst = store.cursor;
      const again = await new IncrementalSync<TestDoc>({ source: new FakeSource(docs, clock, []), store, clock }).run();
      expect(again).toMatchObject({ status: "succeeded", enqueued: 0 });
      expect(store.cursor).toEqual(cursorAfterFirst);
      expect(store.enqueued).toHaveLength(3);
    });

    it("keeps page 1 committed and counted when commitPage fails on page 2", async () => {
      const docs = docsOneSecondApart(5);
      const { store, source, clock } = setup({ docs, pageSize: 2 });
      let commits = 0;
      const flaky = Object.assign(Object.create(store), {
        commitPage: async (d: TestDoc[], last: Cursor) => {
          if (++commits === 2) throw new Error("enqueue failed");
          return store.commitPage(d, last);
        },
      });
      const result = await new IncrementalSync<TestDoc>({ source, store: flaky, clock, pageSize: 2 }).run();
      expect(result).toEqual({ status: "failed", pages: 1, fetched: 2, enqueued: 2, error: "enqueue failed" });
      expect(store.cursor).toEqual({ modified: docs[1]!.modified, name: docs[1]!.name });
    });

    it("always fetches the first page, even if the clock is already past the budget", async () => {
      const { source, clock, store } = setup({ docs: docsOneSecondApart(4), pageSize: 2 });
      const slowStart: Clock = { nowMs: (() => { let calls = 0; return () => (calls++ === 0 ? clock.nowMs() : clock.nowMs() + 200_000); })() };
      const result = await new IncrementalSync<TestDoc>({ source, store, clock: slowStart, pageSize: 2 }).run();
      expect(source.calls).toHaveLength(1);
      expect(result.status).toBe("incomplete");
    });

    it("rejects a non-positive pageSize", () => {
      const { store, source, clock } = setup();
      expect(() => new IncrementalSync<TestDoc>({ source, store, clock, pageSize: 0 })).toThrow(/pageSize/);
    });
  });
});
