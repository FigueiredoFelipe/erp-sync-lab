// Ports used by IncrementalSync (PLAN "Source A: incremental fetch"). IncrementalSync itself is
// written by hand against tests written first (constitution, principle 6).

// Position in ERPNext's (modified, name) order. `modified` is the exact string ERPNext returns,
// fixed-width "YYYY-MM-DD HH:MM:SS.ffffff", naive local time (America/New_York).
export type Cursor = { modified: string; name: string };

export type ChangedPage<Doc> = {
  docs: Doc[]; // ordered by (modified, name), at most `limit` invoices
  last: Cursor | null; // position of the last doc in the page; null when the page is empty
};

// Source A as seen by the sync: returns invoices strictly after `after` in (modified, name) order.
export interface ChangeSource<Doc> {
  fetchChangedPage(after: Cursor, limit: number): Promise<ChangedPage<Doc>>;
}

// Thrown by a ChangeSource when the ERP stays unavailable (5xx, 429, timeout) after its own retries.
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

export type RunStatus = "succeeded" | "incomplete" | "failed";

export type RunResult = {
  status: RunStatus;
  pages: number;
  fetched: number;
  enqueued: number;
  error?: string;
};

// Persistence as seen by the sync. commitPage enqueues the docs and moves the cursor forward-only,
// in one transaction (internal.enqueue_page); it returns how many docs were actually enqueued.
export interface SyncStore<Doc> {
  readCursor(): Promise<Cursor | null>;
  // Status of the previous finished run, or null if there is none.
  lastRunStatus(): Promise<RunStatus | null>;
  commitPage(docs: Doc[], last: Cursor): Promise<{ enqueued: number }>;
  startRun(): Promise<string>;
  finishRun(runId: string, result: RunResult): Promise<void>;
}

// Injected so tests control time (overlap window and the 100 s budget).
export interface Clock {
  nowMs(): number;
}
