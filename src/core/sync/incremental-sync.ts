import type { ChangeSource, Clock, Cursor, RunResult, RunStatus, SyncStore } from "./contracts.ts";

export type IncrementalSyncOptions<Doc> = {
  source: ChangeSource<Doc>;
  store: SyncStore<Doc>;
  clock: Clock;
  pageSize?: number; // default 100
  overlapMinutes?: number; // default 65
  budgetMs?: number; // default 100_000
};

/**
 * Incremental fetch of Source A (PLAN "Source A: incremental fetch"; R01, EC03, EC05, EC11).
 * Implemented against incremental-sync.test.ts and reviewed by two adversarial reviewers (constitution, principle 6).
 *
 * Expected behaviour of run():
 * - Calls store.startRun() once at the start and store.finishRun(runId, result) once at the end,
 *   with the same RunResult that run() returns.
 * - Reads the stored cursor. With no cursor, the first fetch starts from the beginning:
 *   after = { modified: "0001-01-01 00:00:00.000000", name: "" }.
 *   With a cursor (M, N), the first fetch starts at { modified: M - overlapMinutes, name: "" },
 *   computed as wall-clock arithmetic on the naive "YYYY-MM-DD HH:MM:SS[.ffffff]" string
 *   (microseconds kept or padded to 6 digits; crosses midnight, month and year boundaries).
 *   Exception: if the previous run was "incomplete" (it stopped mid-backlog on the budget), the
 *   run resumes exactly at (M, N), with no overlap, so a backlog larger than one run can't livelock.
 * - A full page whose `last` is not after the position it was fetched from is a source bug: the
 *   run ends "failed" instead of spinning until the budget runs out.
 * - Fetches pages of at most pageSize docs. Each non-empty page is committed with
 *   store.commitPage(page.docs, page.last) before the next fetch, and the next fetch starts
 *   after that page's `last`. The store moves the cursor forward-only; the sync never writes it
 *   any other way.
 * - A page with fewer than pageSize docs (including an empty one) ends the run: "succeeded".
 * - Before each fetch after the first, if clock.nowMs() - start >= budgetMs, the run stops
 *   without fetching: "incomplete" (committed pages stay committed; the next run continues).
 * - Any error from the source (SourceUnavailableError or other) or from the store is caught:
 *   status "failed", error = the error's message; run() never throws. If startRun fails there is
 *   no run to finish; if finishRun fails the result is returned as "failed" with that error.
 * - RunResult counts: pages = pages committed, fetched = docs in those pages,
 *   enqueued = sum of commitPage(...).enqueued.
 */
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_OVERLAP_MINUTES = 65;
const DEFAULT_BUDGET_MS = 100_000;
const BEGINNING: Cursor = { modified: "0001-01-01 00:00:00.000000", name: "" };

export class IncrementalSync<Doc> {
  readonly #source: ChangeSource<Doc>;
  readonly #store: SyncStore<Doc>;
  readonly #clock: Clock;
  readonly #pageSize: number;
  readonly #overlapMinutes: number;
  readonly #budgetMs: number;

  constructor(options: IncrementalSyncOptions<Doc>) {
    this.#source = options.source;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) throw new Error(`pageSize must be a positive integer, got ${this.#pageSize}`);
    this.#overlapMinutes = options.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES;
    this.#budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  async run(): Promise<RunResult> {
    const counts = { pages: 0, fetched: 0, enqueued: 0 };
    let runId: string;
    try {
      runId = await this.#store.startRun();
    } catch (error) {
      return { status: "failed", ...counts, error: messageOf(error) };
    }

    const startedAt = this.#clock.nowMs();
    let result: RunResult;
    try {
      const status = await this.#fetchPages(startedAt, counts);
      result = { status, ...counts };
    } catch (error) {
      result = { status: "failed", ...counts, error: messageOf(error) };
    }

    try {
      await this.#store.finishRun(runId, result);
    } catch (error) {
      // The pages stay committed; the run row stays "running" and the next poll marks it failed.
      return { ...result, status: "failed", error: `finishRun failed: ${messageOf(error)}` };
    }
    return result;
  }

  async #fetchPages(startedAt: number, counts: { pages: number; fetched: number; enqueued: number }): Promise<RunStatus> {
    const stored = await this.#store.readCursor();
    const resumingBacklog = (await this.#store.lastRunStatus()) === "incomplete";
    // Re-read an overlap window before the cursor: a transaction can commit after another one that
    // stamped a later `modified`, and ERPNext's naive New York clock repeats an hour when DST ends.
    // Replays are cheap because the store skips versions it already enqueued. After an incomplete
    // run the cursor is mid-backlog, not at the tip, so the run resumes exactly where it stopped.
    let after: Cursor =
      stored === null
        ? BEGINNING
        : resumingBacklog
          ? stored
          : { modified: minusMinutes(stored.modified, this.#overlapMinutes), name: "" };

    for (let first = true; ; first = false) {
      if (!first && this.#clock.nowMs() - startedAt >= this.#budgetMs) return "incomplete";

      // The cursor is (modified, name), not modified alone: invoices sharing a timestamp across a
      // page boundary would otherwise be skipped or read twice.
      const page = await this.#source.fetchChangedPage(after, this.#pageSize);
      if (page.docs.length >= this.#pageSize && (page.last === null || compareCursor(page.last, after) <= 0)) {
        throw new Error(`Source returned a full page that does not advance past ${after.modified} ${after.name}`);
      }
      if (page.last !== null) {
        // Commit before fetching the next page. The store enqueues the page and moves the cursor
        // forward in one transaction, so a crash after this point replays, never leaves a gap.
        const { enqueued } = await this.#store.commitPage(page.docs, page.last);
        counts.pages++;
        counts.fetched += page.docs.length;
        counts.enqueued += enqueued;
        after = page.last;
      }
      if (page.docs.length < this.#pageSize) return "succeeded";
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareCursor(a: Cursor, b: Cursor): number {
  if (a.modified !== b.modified) return a.modified < b.modified ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Wall-clock arithmetic on a naive "YYYY-MM-DD HH:MM:SS[.ffffff]" string: the value is treated as UTC
// only to do calendar math, and the microseconds are carried over (padded to 6 digits).
function minusMinutes(modified: string, minutes: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(modified);
  if (match === null) throw new Error(`Unexpected cursor format: ${modified}`);
  const [, y, mo, d, h, mi, sec, fraction = ""] = match;
  const micros = fraction.padEnd(6, "0");
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi) - minutes, Number(sec), 0);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${micros}`
  );
}
