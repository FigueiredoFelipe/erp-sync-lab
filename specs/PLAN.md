# Plan

How the system is built. Every decision respects `CONSTITUTION.md` and points to the spec IDs it serves (R, BR, EC, AC, US in `SPEC.md`, as revised on 2026-10-18). Nothing from the spec's "Out of scope" appears here.

## Architecture overview

Serves: R01–R15 (structure); constitution "Stack" and "Architecture".

```
                    ┌──────────────── pg_cron (schedules live in migrations) ────────────────┐
                    │ every 5 min       every 1 min            every 5 min        daily       │
                    ▼                   ▼                      ▼                   ▼
ERPNext ──GET──► erpnext-poll      invoice-consumer ◄─┐   legacy-ingest      reconcile-erpnext
  │               │ IncrementalSync     │            │     │ oldest new file    │ per-document diff
  │               │ invoices + Deleted  │ validate → │     │ in legacy-uploads  │ ERPNext vs store
  │               │ Document            │ apply +    │     │ → register_file    ▼
  │               │ → enqueue_page      │ delete msg │     │   (1 txn)       reconciliation_result
  │               ▼   (1 txn)           ▼  (1 txn)   │     │
  │          pgmq "invoice_events" ──────────────────┘◄────┘   ◄── revalidate (mapping migration)
  │               ▲              │ attempts > 5
  └─webhook (P2)─► erpnext-webhook       └──► "invoice_events_dlq" + dead_letter row
                  (verify HMAC, enqueue hint)

Postgres: public = read models behind RLS (invoice, invoice_line, quarantine, customer, freshness views…)
          internal = write functions and control tables, not exposed through the API
Next.js on Vercel (read-only): API routes → services → Postgres with the signed-in user's session (RLS)
```

What travels on each arrow:

| Arrow | Payload |
|---|---|
| ERPNext → `erpnext-poll` | Pages (≤100) of Sales Invoices of the configured company with docstatus 1 or 2, parent fields plus nested `items`, ordered by (`modified`, `name`); and new rows of `Deleted Document` for Sales Invoice. |
| `erpnext-poll` → Storage `raw` | Each new document version as returned, at `erpnext/<name>/<docstatus>-<modified>.json`. |
| `erpnext-poll` → queue | `record` per new invoice version; `tombstone` per deleted invoice. |
| Storage `legacy-uploads` → `legacy-ingest` | One CSV export file per run, never modified after upload. |
| `legacy-ingest` → queue | One `record` per invoice number (rows grouped), plus a `tombstone` per Source B invoice missing from the file (BR10). |
| `erpnext-webhook` → queue (P2) | `hint`: document name only. |
| mapping migration → queue | `revalidate` per stored record whose customer resolution may have changed. |
| queue → `invoice-consumer` | ≤10 messages per run, invisible for 180 s while processed. |
| `invoice-consumer` → Postgres | Per message, one call to `internal.apply_record`, which applies the outcome and deletes the message in the same transaction. |

Rationale: Every source, push or pull, converges on one queue and only the consumer writes the canonical tables, so validation lives in one place and the two sources cannot disagree on what a valid invoice is. Write functions live in the `internal` schema, which the API does not expose, so nobody holding the public key can call them.

## Repository layout

Serves: constitution "Architecture" (services, adapters), "Quality", principle 6.

- `src/core/` — runtime-agnostic TypeScript, imported by Edge Functions (Deno), Next.js and Jest (Node): canonical types, adapters, validation, customer resolution, trend, and `IncrementalSync`, implemented by the agent against tests written first and reviewed by two adversarial reviewer agents before merge (principle 6). No Node- or Deno-specific APIs; relative imports with `.ts` extensions; erasable syntax only.
- `src/services/` — services called by every handler: `pollService`, `consumerService`, `legacyIngestService`, `reconciliationService`, `revenueService`, `quarantineService`, `freshnessService`. Only services call SQL functions or query tables.
- `supabase/functions/<name>/index.ts` — thin handlers: authenticate the caller, parse input, call one service.
- `supabase/migrations/` — schemas, tables, RLS, grants, SQL functions, queues, cron schedules, and the customer mapping.
- `app/` — Next.js dashboard and API routes; handlers call services.
- `data/` — the Source B sample export and its README of planted errors.
- `scripts/seed/` — the ERPNext seed (see "Tools outside the system").

Rationale: Business rules are plain TypeScript with no runtime dependencies, so the same code runs in Edge Functions, the web app and the tests, and handlers only authenticate, parse and delegate. SQL functions receive a verdict already decided in TypeScript and enforce only what must be atomic (the version guard, applying the outcome and deleting the message together).

## Canonical model and adapters

Serves: R04, BR07; constitution "All ERP access goes through an ERP adapter".

Each source has an adapter in `src/core/adapters/` that turns a source document into a **canonical candidate**:

```ts
type CanonicalCandidate = {
  source: "erpnext" | "legacy_unit_b";
  sourceDocId: string;           // ERPNext name, or Source B INV_NO (or "<object>#row<n>")
  sourceVersion: string;         // fixed-width, comparable as text (see below)
  rawRef: string;                // Storage path of the raw payload
  sourceCustomer: string | null; // ERPNext customer ID, or Source B CUST_NAME as written
  invoiceDate: string | null;    // ISO date after strict source-specific parsing
  currency: string | null;
  isCreditNote: boolean;
  status: "final" | "cancelled";
  netTotal: number | null;
  lines: { lineNo: number; itemCode: string | null; description: string | null; qty: number; unitPrice: number; netAmount: number }[];
  parseIssues: ReasonCode[];     // e.g. INVALID_DATE found while parsing
};
```

- **ERPNext adapter** (GET only): `fetchChangedPage(cursor, limit)`, `fetchDeletedPage(cursor, limit)` (and `deletedInvoices()`, the same as a `ChangeSource`), `fetchDocument(name)`, `fetchSubmittedDocuments(year)`, `toCandidate(doc)`. Mapping: `posting_date` → `invoiceDate`; `base_net_total` → `netTotal`; `items[].base_net_amount` → line `netAmount` (both in company currency); `docstatus` 2 → `cancelled`; `is_return` → `isCreditNote`. All queries filter on the configured company (`Harvest Table Foods`).
- **ERPNext `sourceVersion`** = `"<docstatus>|<modified>"`, with `modified` formatted to a fixed `YYYY-MM-DD HH:MM:SS.ffffff`. A cancellation (2) always outranks a submission (1).
- **Legacy CSV adapter:** `parseFile(bytes, fileMeta)` returns a whole-file rejection or candidates grouped by `INV_NO`. Line `netAmount` = `QTY × UNIT_PRICE` (BR02). `INV_DATE` is parsed strictly as `MM/DD/YYYY` (BR03). `CURRENCY` comes from its own column (BR04). Source B has no credit-note marker, so `isCreditNote` is false.
- **Source B `sourceVersion`** = the file's export date, `YYYY-MM-DD`, from its name. The bucket can't hold two files with the same name, so two files can't share an export date, and the newest export date is the newest snapshot (BR10).
- The invoice date is always the posting date (R04), never `creation` or `modified`.
- Credit notes (BR07): amounts are stored with the sign the source gives. ERPNext returns (`is_return`) are already negative, so they reduce revenue in the month of their own invoice date. The sign is not validated (see "Known limitations").

Rationale: Adapters translate and never judge, so a candidate may still be wrong and accepts nulls; header and lines use the company-currency fields (`base_*`) so BR02 compares like with like. The version puts `docstatus` first because cancellation is the only revenue-changing transition after submit, so a cancel always wins, even when the naive New York `modified` repeats an hour at the end of daylight saving time.

## Data model

Serves: R04, R06, R07, R09, R10, R12, R13, R14; BR05, BR06, BR10.

Schema `public` (read by the dashboard through RLS):

| Table | Key | Purpose |
|---|---|---|
| `invoice` | (`source`, `source_doc_id`) | Valid invoices only: `source_customer`, `canonical_customer_id`, `invoice_date`, `currency`, `amount`, `is_credit_note`, `source_version`, `mapping_version`, `candidate` (jsonb), `raw_ref`, `updated_at`. The only table revenue figures read. |
| `invoice_line` | (`source`, `source_doc_id`, `line_no`) | Lines of valid invoices, replaced as a set on every apply. Used by drill-down (R12). |
| `quarantine` | (`source`, `source_doc_id`) | Rejected records: `reason_code` (exactly one, see "Validation"), `detail`, `source_customer`, `candidate`, `raw_ref`, `source_version`, `mapping_version`, `first_rejected_at`, `last_rejected_at`, `status` (`open`/`resolved`), `resolved_at`, `resolution`. |
| `customer` | `canonical_id` | Canonical customers, from the mapping. |
| `sync_run` | `id` | Every producer run: `source`, `started_at`, `finished_at`, `status` (`running`/`succeeded`/`incomplete`/`failed`), `fetched` (jsonb list of name + version: the run log for AC02), counts, `error`. |
| `source_file` | `object_name` | Source B file ledger: `exported_at`, `uploaded_at`, `content_sha256`, `status` (`ingested`/`rejected`), `reject_reason`, `row_count`, `same_content_as` (the previous file it repeats, if any). |
| `reconciliation_run` | `id` | One row per reconciliation run: `started_at`, `finished_at`, `status` (`running`/`succeeded`/`failed`), `erp_total`, `stored_total`, `unexplained` (count), `error`. |
| `reconciliation_result` | unique (`run_id`, `month`, `source_doc_id`) | `month`, `source_doc_id` (null on the month summary row), `erp_amount`, `stored_amount`, `class` (`in_flight`, `quarantined`, `dead_lettered`, `unexplained`, `summary`). |
| `dead_letter` | `msg_id` | Messages moved to the DLQ: source, document ID, version, last error, attempts, payload, `moved_at`. |
| `consumer_heartbeat` | singleton | `last_run_at`, `processed`, `oldest_message_age`, `parked` (since T13: messages that run moved to the DLQ, 0 when none). |

**How services reach `internal`.** Only `public` and `graphql_public` are exposed through the API, and `supabase-js` can only call functions in an exposed schema. So every function a service calls (`enqueue_page`, `register_file`, `begin_attempt`, `apply_record`, `dead_letter`, the test-switch lookup) has a thin wrapper in `public`: `SECURITY DEFINER`, `SET search_path = ''`, EXECUTE granted **only** to `service_role` (the T2 migration already strips EXECUTE from `PUBLIC` on every new function). The logic and the tables stay in `internal`. Decided 2026-10-18 instead of exposing a new schema, which would have meant changing the project's API settings.

Schema `internal` (not exposed through the API; RLS on every table with no policies, as defense in depth: `postgres`, which owns the SECURITY DEFINER functions, and `service_role` bypass it):

| Table | Key | Purpose |
|---|---|---|
| `record_version` | (`source`, `source_doc_id`) | `applied_version` (atomic guard) and `enqueued_version` (stops re-enqueuing). |
| `customer_alias` | (`source`, `match_key`) | Source A: ERPNext customer ID. Source B: the alias as the mapping writes it; the consumer normalizes it when it builds its lookup index, so normalization lives only in TypeScript. Points to `canonical_id`. |
| `mapping_state` | singleton | Current `mapping_version`. |
| `sync_cursor` | (`source`, `stream`) | `invoices`: (`cursor_modified timestamp(6)`, `cursor_name`). `deleted`: (`creation`, `name`) of `Deleted Document`. |
| `message_attempt` | `msg_id` | Attempts actually started per message (see "Queue"). |
| `allowlist` | `email` | Who may see data (R11). |
| `test_switch` | `name` | Fault injection for AC03; read only when the `ENABLE_TEST_SWITCHES` env flag is set. |

Rationale: Quarantine and the canonical table share one key, so a record is in exactly one of them, and figures read only `invoice`, so no query can accidentally sum a rejected invoice. The stored `candidate` lets a record be re-validated after a mapping change without fetching it from the source again, and control tables stay in `internal`, invisible to the public API.

## Source A: incremental fetch

Serves: R01, BR01, EC01, EC03, EC05, EC11, EC12, AC01, AC02, AC11.

`erpnext-poll` runs every 5 min (Q3) and drives `IncrementalSync`:

1. Close leftovers: any `sync_run` still `running` from a killed run becomes `failed`. Insert a new `running` row.
2. **Invoices stream.** Read the cursor (M, N). Start reading at `M − 65 minutes` with name `""` (the overlap window fixed by R01).
3. Fetch pages of `GET /api/resource/Sales Invoice` with:
   - `filters=[["company","=",COMPANY],["docstatus","in",[1,2]],["modified",">=",m]]`
   - `or_filters=[["modified",">",m],["name",">",n]]`, which Frappe combines as `filters AND (or…)`, giving exactly `modified > m OR (modified = m AND name > n)`
   - `order_by="modified asc, name asc"`, `limit=100`
   - `fields` = the parent fields plus `{"items": [...]}`, so lines come nested and the limit counts invoices
4. Per page, call `internal.enqueue_page(docs, page_last)`. In one transaction it:
   - drops documents whose version is ≤ `enqueued_version` or that are already in `dead_letter` at that version;
   - sends the rest with `pgmq.send_batch`;
   - raises `enqueued_version`;
   - moves the cursor **only forward** (`WHERE (new_modified, new_name) > (cursor_modified, cursor_name)`).

   Before that call, the service writes the raw JSON of every document in the page (one object per document version; same path, same content, so a rewrite is harmless), so a message never points at a missing object; a failed write fails the run before anything is enqueued. The next page starts after the last row of this page.
5. **Deleted stream** (T14; runs first in each poll, same `sync_run`). `GET /api/resource/Deleted Document` with `filters=[["deleted_doctype","=","Sales Invoice"],["creation",">=",c]]`, `or_filters=[["creation",">",c],["name",">",n]]`, `order_by="creation asc, name asc"` and fields `name`, `deleted_doctype`, `deleted_name`, `creation`, `data` (names confirmed with a GET on 2026-10-18; `data` is the deleted document as JSON text). It is driven by its own `IncrementalSync` with its own (`creation`, `name`) cursor, stream `deleted`, through `enqueue_page(p_source, p_stream, …)`, which moves only that stream's cursor, forward only. It always re-reads the 65-minute overlap window.
   - Each row enqueues a `tombstone` `{v:1, kind:"tombstone", source:"erpnext", sourceDocId:<deleted_name>, sourceVersion:"3|<creation>", rawRef:"erpnext/deleted/<deleted_name>.json"}` (EC12); the raw Deleted Document row is written at `rawRef` first. `3|` outranks any `1|`/`2|` version of the invoice, and `enqueue_page` skips a tombstone already enqueued.
   - `pollService.tombstoneFor` skips a deleted draft (`docstatus` 0 in `data`: it never counted, and ERPNext can hand a draft amendment's name out again) and an invoice of another company. Any other row, including one whose `data` is missing or unreadable, gets a tombstone (fail-closed). Skipped rows still move the cursor.
   - Budget: the deleted stream is capped at 20 s, and the invoices stream gets the rest of the 100 s. Each stream fails on its own (a broken deleted stream doesn't stop invoices); the run's status is the worse of the two, and the error names the stream.
6. Stop when both streams return a short page (`succeeded`), or when the run has used 100 s (`incomplete`: the cursor already moved, so the next run continues with no gap and no rewind).
7. ERP 429/5xx/timeouts: retry with exponential backoff, honoring `Retry-After`, within the time budget. If it runs out, the run is `failed`, and the cursor stays where the last committed page left it.

With no stored cursor, the first run starts from `{ modified: "0001-01-01 00:00:00.000000", name: "" }`; the overlap is wall-clock arithmetic on the naive `modified` string, and `RunResult.pages` counts committed (non-empty) pages.

Every document fetched is recorded in `sync_run.fetched`, which is the run log AC02 inspects. "Last successful sync" for Source A (R10) is the `finished_at` of the latest `succeeded` run, so a failing run never moves it (EC05, AC11). A late invoice for a past month shows up in the run that fetched it (EC11).

Rationale: The (`modified`, `name`) cursor keeps invoices that share a `modified` value at a page boundary from being skipped or repeated (EC03), and the 65-minute overlap covers long transactions that commit late and the hour New York repeats when daylight saving time ends; re-reading is cheap because `enqueue_page` drops what is already enqueued. Enqueue and cursor move commit together and only forward, so a crash means a replay, never a gap, and polling `Deleted Document` closes the case where an invoice is cancelled and deleted between two polls and would otherwise keep counting.

## Source A: webhooks (P2)

Serves: R02, EC02, AC08, AC09.

- ERPNext Webhook on Sales Invoice for `on_submit`, `on_cancel`, `on_update_after_submit` and `on_trash`, with "Enable Security" on and a `Content-Type: application/json` header configured (ERPNext doesn't send one by itself).
- `erpnext-webhook` is the only function deployed with `verify_jwt = false`. It reads the raw body (`await req.arrayBuffer()`) before any parsing and checks `X-Frappe-Webhook-Signature` = base64(HMAC-SHA256(secret, body)) with a constant-time compare. A missing or invalid signature gets HTTP 401 with a Problem Details body, and nothing is queued (AC09).
- If the signature is valid, the handler (`src/http/erpnext-webhook-handler.ts`) reads `{"name": …}` from the body (anything else: 400 Problem Details), calls `webhookService.enqueueHint(name)`, which sends `{v:1, kind:"hint", source:"erpnext", sourceDocId}` through `public.enqueue_hint` (service_role only; a hint has no version, so it skips `record_version`), and returns 200. A missing `ERPNEXT_WEBHOOK_SECRET` is a 500 and nothing is queued. The consumer fetches the current document through the adapter, so a late or reordered webhook can't apply stale data.
- The consumer resolves a hint with `webhookService.resolveHint(name)`: it fetches the document (`adapter.fetchDocument`, reduced to the poll's fields), writes its raw JSON and returns the same `record` message the poll would build; a draft or another company's invoice is `skip`; a 404 is `gone`.
- Hints are best-effort. If fetching the document fails transiently (`SourceUnavailableError`), the hint is deleted, not retried, and polling remains the backstop. A 404 (`gone`) is also just deleted: the deleted stream of the poll enqueues the tombstone, because only the Deleted Document row carries the deletion time the tombstone's version needs (changed in T21; the earlier text said a 404 becomes a tombstone).
- The secret lives in Supabase secrets (principle 5). Polling keeps running unchanged, and the same invoice arriving by both paths is stored once (EC02).

Rationale: Frappe v16 sends webhooks from a background job after commit, retries three times within about five seconds and then gives up silently, and Data Import fires none, so the webhook is only a latency hint and polling stays the source of truth. A hint carries only the document name and the consumer fetches the current version, so ordering does not matter, and dropping hints while the ERP is down keeps the DLQ free of noise.

## Source B: export file ingestion

Serves: R03, R10, BR03, BR06, BR10, EC06, EC07, EC08, AC04, AC14, AC17, AC19.

- An operator uploads the export to the Storage bucket `legacy-uploads` as `unit_b_export_YYYY-MM-DD.csv`, where the date is the export date. The bucket allows inserts only, with no update policy and `upsert: false`, so an uploaded file is never replaced.
- `legacy-ingest` runs every 5 minutes (R03). It processes **one file per run**: the object with the oldest export date whose `object_name` isn't yet in `source_file`.
  1. **Older than the newest ingested file** (BR10): if its export date is earlier than the newest export date already ingested, the whole file is `rejected` (`older than <date>`) and nothing from it is queued (AC17).
  2. **Whole-file checks:**
     - the file name carries a valid export date;
     - the header is exactly `INV_NO, CUST_NAME, INV_DATE, CURRENCY, LINE_ITEM, QTY, UNIT_PRICE, INV_TOTAL`;
     - there are between 1 and 5,000 data rows.

     On any failure the file is `rejected` with the reason, and nothing from it is queued (EC07).
  3. **Same content as the newest ingested file** (SHA-256 equal): the file is recorded as `ingested` with `same_content_as` set. Its export date becomes the newest Source B export date, for freshness (R10) and the trend as-of date (BR08). No message is sent, because the figures can't change (EC06, AC14). Content that repeats an *older* file is not a no-op: it is processed normally, because it differs from the current snapshot.
  4. **Parse and group:** parse the rows with a strict CSV parser and group them by `INV_NO` (BR06):
     - A row without `INV_NO` can't be grouped. It becomes a record on its own, keyed `"<object_name>#row<n>"`, with a `MISSING_FIELD` parse issue (BR03, Q8).
     - Rows of one `INV_NO` that disagree on an invoice-level column (`CUST_NAME`, `INV_DATE`, `CURRENCY`, `INV_TOTAL`) put the invoice in `CONFLICTING_DUPLICATE`.
     - Identical rows (same hash of all normalized columns) are arbitrated by `INV_TOTAL`. If it matches the line sum with each repeated row counted once, the repeats are export duplicates and are dropped. If it matches with every row counted, they are real lines and are kept. Otherwise the invoice keeps all rows and BR02 decides (`TOTAL_MISMATCH`) (AC19).
     - As built in T11: a row's number `<n>` is its 1-based data row (the header isn't counted). Fields are trimmed; `CUST_NAME` keeps its inner spacing. Invoice-level columns conflict when they differ after trimming (amounts compared in cents, so `3` and `3.00` agree). A `QTY`, `UNIT_PRICE` or `INV_TOTAL` that isn't a plain decimal (`QTY` up to 4 decimals, amounts up to 2) is flagged `MISSING_FIELD`. Repeated-row arbitration uses BR02's USD 0.01 tolerance. A file that isn't valid UTF-8 or that the strict parser refuses (unclosed quote, wrong column count) is rejected whole; a UTF-8 BOM, CRLF and blank lines are accepted.
  5. **Register:** call `internal.register_file(file_meta, records)`. In one transaction it inserts the `source_file` row, sends one `record` per invoice, and sends a `tombstone` for every Source B invoice in `invoice` or in open `quarantine` whose number isn't in this file (BR10, AC17).
- As built in T12 (migrations `20261018220000`, `20261018220100`):
  - `public.register_file(p_file, p_records)` wraps `internal.register_file` (service_role only). It takes an advisory lock, so "newest file" and the tombstone set can't change under it, and an `object_name` already in `source_file` returns `already_registered` with no message (an overlapping or retried run).
  - Step 1 rejects an export date **not after** the newest ingested one, so a second object with the same date (e.g. under a folder) is also rejected; a rejected file never becomes the newest. Whole-file failures found in TypeScript arrive as `rejectReason`; the older-than check still runs first, so a stale file reads `older than <date>` even when it is also malformed.
  - The tombstone set is every Source B key in `invoice`, in open `quarantine`, **or still in flight** (`record_version.enqueued_version` ahead of `applied_version`) that isn't in the file. Without the in-flight part, a key removed by the next file before the consumer applied the previous file's record would be applied later and stay in the figures. The consumer must therefore accept a tombstone for a key that has no `invoice` or `quarantine` row (nothing to remove); the version guard makes a late older record lose to it.
  - `enqueued_version` is raised to the export date for every record and tombstone sent, as for Source A.
  - The service lists the bucket, asks `public.unregistered_files(names)` which are new, and takes objects whose name carries no valid date first (rejected without a download), then the oldest export date. Every run writes a `sync_run` row (source `legacy_unit_b`), also when idle; a rejected file is a `succeeded` run, the rejection lives in `source_file`. `fetched` holds `{name, sourceVersion, outcome}` of the file.
  - The bucket is private, 2 MiB per object, CSV/plain-text MIME types, with no `storage.objects` policy: only the service role touches it, and the operator's upload uses `upsert: false` (`npm run demo:upload -- <file> [--as <name>]`). The service checks the 2 MiB again before parsing.
  - BR06's `CONFLICTING_DUPLICATE` reaches the consumer as a parse issue; `validate()` must honour it in its slot (after BR04, before BR02). That lands with the consumer track, not in T11/T12.
- Version: every record and tombstone carries the file's export date. A newer export of an invoice replaces the older one and resolves its quarantine if it is now valid (EC08). A Source B tombstone removes the invoice from the figures and closes any open quarantine entry with resolution `removed_from_export` (BR10).
- Freshness (R10): the newest ingested export date, and the `finished_at` of the latest successful `legacy-ingest` run.

Rationale: The bucket is scanned instead of using a trigger because Supabase documents the `storage` schema as read-only and triggers on `storage.objects` have been reported to fire twice per upload; one file per run, oldest first, keeps BR10 simple, since a late stale file is rejected whole instead of resurrecting or deleting invoices. Content identical to the newest file is not rejected because it means "nothing changed as of this date" and refreshes freshness and the trend as-of date, and the 5,000-row cap protects the Edge Function's 2 s CPU and 256 MB memory limits.

## Queue, consumers and failures

Serves: R07, R13, EC04, AC03, AC13; constitution "Runtime limits" and "Errors".

- One durable (logged) pgmq queue `invoice_events`, plus `invoice_events_dlq`. Queues aren't exposed through PostgREST; only services with the service role touch them.
- `invoice-consumer` runs every minute and calls `consumerService.processBatch()`, which reads with `pgmq.read('invoice_events', vt => 180, qty => 10)` and writes `consumer_heartbeat`.
- Each message is processed in its own try/catch, so one bad message doesn't abort the batch:
  1. `internal.begin_attempt(msg_id)` increments `message_attempt.attempts` and commits on its own.
  2. If the 5th attempt fails, or a message comes back with `attempts > 5` (earlier runs died before reaching their catch) (Q4), call `internal.dead_letter(msg_id, error)` through `public.dead_letter_message`. In one transaction it:
     - sends the message to `invoice_events_dlq`, inserts a `dead_letter` row and deletes it from the main queue (R13);
     - if the record's key has a row in `invoice` (an older valid version in the figures), deletes that row and upserts `quarantine` with reason `PROCESSING_FAILED` (R13, principle 1). A message too malformed to carry a key only goes to the DLQ. A message whose version is older than the stored one leaves the figures alone (it would have been `stale`); one without a version (`revalidate`) fails closed.
  3. Otherwise process it by kind:

     | Kind | Handling |
     |---|---|
     | `record` (Source A) | adapter → candidate → validation |
     | `hint` | fetch the current document, then handle as a `record` |
     | `record` (Source B) | the candidate the legacy adapter already parsed → validation (no adapter call) |
     | `tombstone` | cancelled outcome (Source A) or removed outcome (Source B) |
     | `revalidate` | load the stored `candidate` and validate it again with the current mapping |

  4. Call `internal.apply_record(outcome, msg_id)` (next section), which applies the outcome **and** deletes the message in one transaction. If the delete finds nothing (another run took the message after its visibility expired), the apply is still correct because of the version guard.
- Any other error (database error, unexpected exception, malformed message) leaves the message in the queue with visibility `30 s × 2^(attempts − 1)`, capped at 15 minutes, so it counts toward the 5 attempts (Q4). A validation failure isn't an error: it is a quarantine outcome, and the message is deleted.
- If the function dies mid-batch, applied messages are already gone, and the rest reappear after 180 s and are applied once (EC04). The visibility timeout of 180 s is longer than the 150 s wall-clock limit, so a message can't reappear while the run that read it is still alive.
- `attempts` counts what was actually started, unlike pgmq's `read_ct`, which also counts batch-mates of a run that crashed. A message that crashes the whole isolate therefore can't drag the other nine into the DLQ.
- pg_cron calls each function through pg_net (asynchronous), with an `x-cron-secret` header from Vault that the handler compares in constant time. The request timeout is set above the run time, but correctness never depends on the HTTP response. Whether a function keeps running after pg_net drops the connection is unconfirmed; it is checked in the first consumer task.

Rationale: Applying the outcome and deleting the message commit in one transaction, so a crash either applied nothing or everything, and a replay changes nothing thanks to the version guard; pgmq has no native DLQ or backoff, so both are built by hand, with an own attempt counter because `read_ct` would charge all ten messages of a batch that died. The cron secret stops anyone with the public key from triggering polls in a loop and exhausting ERPNext's daily server-time quota, and a record that cannot be reprocessed takes its older valid version out of the figures (`PROCESSING_FAILED`), since that number can no longer be vouched for.

## Idempotency and versioning

Serves: R06, R07, BR10, EC01, EC02, EC04, EC06, EC10, EC12, AC01, AC03, AC16, AC17; constitution principle 2.

- The unique key everywhere is (`source`, `source_doc_id`).
- `apply_record` starts with the guard, as one atomic statement:

  ```sql
  INSERT INTO internal.record_version AS rv (source, source_doc_id, applied_version)
  VALUES ($1, $2, $3)
  ON CONFLICT (source, source_doc_id) DO UPDATE SET applied_version = EXCLUDED.applied_version
  WHERE rv.applied_version IS NULL OR rv.applied_version <= EXCLUDED.applied_version
  RETURNING 1;
  ```

  - `applied_version IS NULL` is needed because the producer creates the row with only `enqueued_version`; without it, `NULL <= x` would make every first apply look stale (found in T9).

  - No row returned means the incoming version is older: delete the message and stop.
  - The row lock serializes concurrent applies of the same key, so two overlapping consumer runs can't apply an older version over a newer one.
- Applying replaces rather than appends: `INSERT … ON CONFLICT (source, source_doc_id) DO UPDATE` on `invoice`, with its lines deleted and reinserted as a set in the same transaction.
- Outcomes, decided in TypeScript and applied in SQL:
  - **valid**: upsert `invoice` and its lines, then mark any open quarantine row for the key `resolved` (EC08).
  - **invalid**: upsert `quarantine` as `open`, then delete any `invoice` row for the key, so the previous valid version leaves the figures (R06, EC10, AC16).
  - **cancelled** (BR01, Source A tombstone): delete any `invoice` row, then resolve any open quarantine row with resolution `cancelled` (EC01, EC12).
  - **removed** (BR10, Source B tombstone): the same, with resolution `removed_from_export` (AC17). Rows without `INV_NO` from an older file are tombstoned the same way, since their `#row` keys never appear in a newer file.
  - A tombstone carries no candidate. One for a key that has no `invoice` and no `quarantine` row (enqueued but not applied yet) is a successful no-op: the guard records its version, so the older record is refused as `stale` when it arrives.
  - Versions accepted per source (since `20261018200400`): ERPNext `1|`, `2|` and `3|` (Deleted Document, tombstone only, outranks both) plus the fixed-width timestamp; Source B the export date `YYYY-MM-DD`. Drafts (`0|`) are still refused. `removed` is Source B only; `cancelled` is ERPNext only.
  - **dead-lettered** (R13): not an outcome of `apply_record`; `internal.dead_letter` removes an older valid version and quarantines the key with `PROCESSING_FAILED`.
- Equal versions are re-applied on purpose and give the same result. That is what lets `revalidate` re-check a record without a new source version.
- The outcome carries the `mapping_version` it was computed with. If the mapping changed in between, `apply_record` refuses it as a transient error and the message is retried with the new mapping.
  - Since T8: the consumer loads the aliases and the `mapping_version` in one call (`load_customer_index`) once per batch; `apply_record` reads `mapping_state` `FOR SHARE`, so a mapping change waits for in-flight applies, and refuses a different version with SQLSTATE `40001` (backoff and retry). A valid outcome must carry a `canonicalCustomerId` listed in `customer`.

Rationale: Idempotency has two halves: the unique-key upsert makes duplicates harmless, and the version guard makes reordering harmless. The guard must be a single conditional statement, because two consumer runs can overlap (cron every minute, up to 150 s each) and a read-then-write check would let an older version win.

## Validation and quarantine

Serves: R06, R09, BR01, BR02, BR03, BR04, BR05, BR06, AC04, AC06, AC16; constitution principle 1.

`src/core/validation/` is a pure function `validate(candidate, customerIndex, config) → valid | invalid(reasonCode) | cancelled`, unit-tested rule by rule. It checks the rules in the spec's fixed order and stops at the first failure, so every invalid invoice gets **exactly one** reason code.

| Order | Rule | Check | Reason code |
|---|---|---|---|
| — | BR01 | `status = cancelled` gives the cancelled outcome before any check. Drafts never reach validation, because Source A fetches only docstatus 1 and 2 (AC06). | — |
| 1 | BR03 | Customer, invoice date, currency and at least one line are present; a Source B row without `INV_NO` is a record on its own and fails here (Q8) | `MISSING_FIELD` |
| 1 | BR03 | Date matches its source's format and falls within the configured period (default 2026-01-01 to 2026-12-31) | `INVALID_DATE` |
| 2 | BR04 | Currency is USD | `UNSUPPORTED_CURRENCY` |
| 3 | BR06 | Rows of one invoice disagree on an invoice-level column (flagged by the Source B adapter while grouping) | `CONFLICTING_DUPLICATE` |
| 4 | BR02 | `abs(netTotal − Σ line netAmount) ≤ 0.01` | `TOTAL_MISMATCH` |
| 5 | BR05 | Customer resolves through `customer_alias` | `UNKNOWN_CUSTOMER` |
| — | R13 | Not set by `validate`: the DLQ move sets it when a record that failed 5 times had an older valid version in the figures (see "Queue") | `PROCESSING_FAILED` |

The quarantine view (R09) lists open rows with source, source document reference, reason code, detail and `last_rejected_at`. Rejected Source B files are listed alongside, with their file-level reason.

Rationale: Validation is a pure function with no database or network access, so every rule has a unit test without mocks, and stopping at the first broken rule in a fixed order gives each rejected invoice exactly one reason (otherwise UB-26005 would carry both `CONFLICTING_DUPLICATE` and `TOTAL_MISMATCH`, and AC04 would have no single expected result). The period is configuration so the system does not quarantine everything once the configured year ends.

## Customer resolution

Serves: R05, R15, BR05, EC09, AC15.

- The customer mapping is a versioned file in the repository. Each change is a new migration, `supabase/migrations/<timestamp>_customer_mapping.sql`, which calls `internal.apply_customer_mapping('<json>'::jsonb)`. The latest one is the current mapping. Every canonical customer is listed, including those that appear in only one source:

  ```json
  { "canonical_id": "acme-foods", "display_name": "Acme Foods Inc.",
    "erpnext": ["Acme Foods Inc."], "legacy_unit_b": ["ACME FOODS"] }
  ```

- Source A resolves by ERPNext customer ID, exactly.
- Source B resolves by `normalize(name)`: lowercase, punctuation removed, whitespace collapsed, legal suffixes (Inc, LLC, Co) kept. The normalized name must equal a normalized alias listed in the mapping. Similarity never decides.
- The mapping stores aliases as written; `buildCustomerIndex` (`src/core/customers/`) normalizes the Unit B ones and fails closed if two of them normalize to the same key for different customers. A unit test checks the shipped mapping against the seed and `data/legacy_unit_b.README.md`.
- The mapping migration is named `<timestamp>_customer_mapping.sql`, with a timestamp after the functions it calls (`20261018200900` for the first one).
- `apply_customer_mapping` runs in one transaction:
  1. Replaces `customer` and `customer_alias`.
  2. Bumps `mapping_version`.
  3. Enqueues a `revalidate` for every open `UNKNOWN_CUSTOMER` quarantine row (R15, EC09, AC15) **and** for every stored invoice whose alias changed or disappeared. A removed alias therefore sends its invoices back to quarantine instead of leaving them under a stale customer.
     - "Alias changed or disappeared" is computed per canonical customer: any alias added, moved or removed, or the customer itself removed, re-validates all of that customer's invoices; invoices stored before the first mapping (no `canonical_customer_id`) are re-validated too. Over-inclusive on purpose, since re-validating an unchanged record at the same version changes nothing.
  4. The consumer handles `revalidate` by loading the candidate stored with the invoice or the open quarantine row (`load_stored_record`) and validating it with the current mapping, at the same version. A key with nothing stored (tombstoned meanwhile) is acknowledged and skipped. `PROCESSING_FAILED` rows are never re-validated: their candidate is the old version the failed message was replacing (R13).

Rationale: Normalization only builds the lookup key and the reviewed mapping decides, so no two customers are ever merged automatically. Shipping the mapping as a migration keeps the Supabase key out of GitHub, which the constitution does not list as a secret store (principle 5), and re-validating stored invoices means that fixing a wrong mapping also moves invoices already counted under the wrong customer.

## Revenue and trends

Serves: R08, BR07, BR08, AC07, AC18, US01, US02, US03.

- Monthly revenue = `Σ invoice.amount` grouped by `date_trunc('month', invoice_date)`, filterable by source, customer and date range (R08). It reads only `invoice`.
- Trend (`src/core/trend/`, BR08 v4) is a pure function `trend(monthlyCents, asOfDate)`. `monthlyCents` is the customer's whole stored history, both sources combined.
  - **As-of date** = the earlier of Source A's last successful sync date and the newest Source B export date. `trendService` reads both and passes the date in.
  - **Complete month:** its last day is before the as-of date. **Has revenue:** net revenue in the month > 0. **Last 3 / previous 3 / last 2** are counted in complete months.
  - Rules, first match wins:
    1. **churned**: revenue in some complete month before the last 2, and none in the last 2.
    2. **new**: the first month with revenue in the stored data is one of the last 3.
    3. previous 3 ≤ 0: **growing** if last 3 > 0, otherwise **stable**.
    4. **growing**: last 3 > previous 3 × 1.15.
    5. **declining**: last 3 < previous 3 × 0.85.
    6. **stable**.
  - The threshold is 15% (Q2). Comparisons use integer cents: `last3 × 100 > prev3 × 115` and `last3 × 100 < prev3 × 85`, so there is no floating-point rounding.
- The figures are P1; the trend labels are P2.

Rationale: The as-of date is a parameter, so tests do not depend on the day they run, and churned and new look at the whole history, so a customer who stopped in March is never labeled new. Integer-cent comparisons implement BR08's "exact, no rounding": in floating point, a customer exactly on the threshold could land on either side.

### Source breakdown on the monthly chart (R19)

Serves: R19, AC32.

- **Data:** `getMonthlyRevenue` already reads `monthly_revenue` by month and source; each month gains `bySource: Record<SourceId, { revenueCents, revenue, invoices }>`, keyed by the canonical source list (`erpnext`, `legacy_unit_b`), every key always present (zero when a source has no invoices); `revenueCents` and `invoices` stay the sums. A view row with a source outside the list makes the service throw (fail-closed: the segments would not add up). `total` gets no breakdown (the table keeps total only). Unit tests: segments add up to the total for every month, including a month where one source is negative and a month with one source absent; the existing `toEqual` assertions in `revenue-service.test.ts` and `revenue-route.test.ts` gain `bySource`.
- **Chart:** Recharts stacked bars (`stackId`) with `stackOffset="sign"`, so a negative source month stacks below zero instead of overlapping the positive segment; ERPNext is the segment nearest zero on its side of the axis, Unit B outside it (fixed order; color follows the source, never its rank). Colors are the first two categorical slots: `--series-1` (blue, light `#2a78d6`, dark `#3987e5`) and a new `--series-2` (orange, light `#eb6834`, dark `#d95926`); the pair passes the palette validator in both modes (worst of both modes: color-blind ΔE 24.7 light / 26.8 dark, normal-vision 33.6 light / 31.8 dark) and is ≥ 3:1 against the chart card (`--surface-1`; light orange is 3.12:1 there and only 2.91:1 on the page's `--surface-0`, so the chart stays on the card). Segments are separated by a 2 px `--surface-1` gap. Only the segment at the free end of each month's stack (the outermost non-zero segment on its side of zero) has rounded corners, decided per cell; a zero segment renders nothing (no gap, no stroke, no hit area) but still appears in the tooltip with $0.00 and 0 invoices. The legend is static (swatches and the two names, no figures, no figure test id), inside the chart card above the plot, always listing both sources; `SkeletonChart` reserves the same legend row (placeholder swatches, no text), so the card's height is identical loading and loaded.
- **Partial month:** each segment of the partial month uses its own source's hatch (`partial-hatch-erpnext`: `--series-1` stripes on `--series-1-soft`; `partial-hatch-legacy_unit_b`: `--series-2` stripes on a new `--series-2-soft`, values measured before use). The stripes carry the 3:1 contrast; the soft fill doesn't need to. No dashed outline: the 2 px gap separates segments, partial or not. The partial note's swatch shows a neutral hatch (`--text-secondary` stripes), since the marking applies to both sources. Each segment keeps `data-partial`.
- **Tooltip:** the month's total stays the tag (largest, boldest; R16, AC20) but neutral: no series swatch, background `--surface-0` with a `--border` outline, text `--text-primary`. Then one line per source in a fixed order matching the stack top-to-bottom (Unit B export, then ERPNext (Unit A)): swatch in the source color, name, revenue, invoices, all text in text tokens. Both lines always appear, including a $0.00 or negative line.
- **Table:** unchanged (total per month).
- **Verification (DevTools):** each segment carries `data-testid="bar-<month>-<source>"`, `data-cents` (signed integer) and `data-partial`; `bar-<month>` is retired (no consumer outside `app/page.tsx`). The check reads `data-cents` per month and source against `select date_trunc('month', invoice_date), source, sum(amount) from invoice group by 1, 2`, checks that each month's segments add up to `revenue-<month>`, reads the tooltip's per-source lines for one complete month and the partial month, and takes screenshots in both themes.

Rationale: Stacking keeps each bar's height equal to the month's total while the colors show where the revenue came from; blue and orange are the palette's first two categorical slots, validated by script for color-blind separation in both themes.

### Financial clarity between Sync health and Revenue (R20)

Serves: R20, AC33–AC37; Q10, Q11.

- **Data, no schema change.** `getMonthlyRevenue` gains `total.bySource`; the Revenue table still shows the total only. `freshness.reconciliation` gains `period` (from `reconciliationPeriod()`, a new export of `reconciliation-service.ts` that the run also uses as its default, so the label and the run can't drift; today January–December 2026, the validation period — no caller passes another period), `lastSucceeded` (newest `succeeded` run), `erpnextValidCents` (sum of `monthly_revenue` for `erpnext` in that period) and `comparison` (the result of `compareWithReconciliation`), all read in the same parallel batch. The Sync health page imports the same period, so its breakdown request (`/api/revenue/monthly` for that period) goes out in parallel with freshness. The reconciliation's computation, tables and tests don't change.
- **Comparison rule (pure, unit-tested, called by the freshness service):** `compareWithReconciliation({ breakdownPeriod, erpnextValidCents, run })` in `src/core/reconciliation/compare.ts` returns `matches` (same period and current ERPNext valid revenue equals the last successful run's `stored_total` to the cent), or a reason: `different-period`, `changed-since-run` (with the run's start time) or `no-successful-run`. The sentence on screen shows the ERPNext figure it compared.
- **Sync health:** the reconciliation card is renamed "ERPNext reconciliation — Unit A only", with the explanatory sentence, its period, and a note under "ERPNext total" (it counts documents in transit, in quarantine or dead-lettered). A latest run that is running or failed shows its state without totals, and the last successful run follows, labeled as the previous successful run; when the latest run is itself the last success it is shown once. No succeeded run → "No reconciliation yet" and no comparison. Words, not dashes, in figure slots ("not available", "not computed: run failed"). A new region "Valid revenue by source" (its own `DataRegion`, R18) shows ERPNext (Unit A), Unit B export (with the newest file's export date, from freshness) and Total (Units A + B); the total is rendered only when both parts loaded; a part with no invoices shows "$0.00 · no invoices in period".
- **Period label:** "<first month> – <last month>"; when the as-of date falls inside the period it adds ", data through <as-of date> (<as-of month> partial)". Months after the as-of month count as $0.00 and are not called partial.
- **Revenue:** three compact figures above the chart (Total revenue, ERPNext (Unit A), Unit B export) for the page's period, from the response the page already loads, with the period label; the chart and table don't change. The page states its period and never claims equality with Sync health.
- **Tests:** `compareWithReconciliation` table (same period equal/unequal, other period, no successful run, failed or running latest with a previous success, a Unit B change leaves the result unchanged); `total.bySource`; freshness `lastSucceeded`/`comparison` (the deep-equal and table-list assertions in `tests/http/freshness-route.test.ts` are updated on purpose); an open quarantine row changes no figure; a part with zero invoices is labeled, not failed; DevTools: figures equal SQL to the cent, both pages.

### Customers table: trends always visible (R21)

Serves: R21, AC38–AC41.

- **Why it overflows (measured):** the table inherits 16 px; each month column is ~118 px (bold Total-row figures plus 24 px padding); with names unwrapped it needs ~1,713 px, wrapped ~1,516 px, while the page gives it 1,034 px (`main.wide` 1,100 px).
- **Density first:** the Customers page uses a wider main (`main.wide-table`, up to 1,680 px; the nav keeps its width); the customers table (`table.customers-table` only — the drill-down and Revenue tables and the global `table/th/td/.table-scroll` rules don't change) uses 14 px, cell padding 6 px 8 px, tabular numerals, customer names wrapping onto at most two lines (~14em, no ellipsis). Below ~640 px the customer column narrows to ~8em and may wrap further, so customer, total and trend still all stay fixed (AC38's two-line rule applies from 1,440 px).
- **Fixed columns:** `border-collapse: separate; border-spacing: 0`, horizontal borders as `border-bottom`; sticky left: `thead th:first-child`, `tbody th[scope=row]`, `tfoot td:first-child`; sticky right: the last two cells of every row, including the empty Trend cell in the footer. Each sticky cell: `background: var(--surface-1)` (and the row-hover background), `z-index: 1` (header corners `2`), a separating `box-shadow` on its inner edge. Total and Trend have fixed widths (`--col-total`, `--col-trend` in ch); the customer width is measured into `--col-left` by `ResizeObserver`. `scroll-padding-inline: var(--col-left) calc(var(--col-total) + var(--col-trend))`, `scroll-margin-inline: 4px` on figure buttons, and a `focusin` handler that corrects `scrollLeft` when the focused element falls under a fixed column.
- **Scrolling:** the native scroller is the source of truth (`role="region"`, `aria-label`, `tabIndex=0`). A mirror scrollbar above the table (`aria-hidden`, `tabIndex=-1`, same box width as the scroller, inner width = the scroller's `scrollWidth`) syncs both ways, each listener writing only when the other differs by ≥ 1 px (no feedback loop, no subpixel ping-pong); one `ResizeObserver` watches scroller and table so a filter change re-syncs; listeners removed on unmount; no smooth scrolling; styled with `scrollbar-width: thin` / `::-webkit-scrollbar` so it shows with overlay scrollbars; hidden when the table fits. Edge cues "◀ More months" / "More months ▶" (`customers-more-left/right`) sit in that mirror row above the table, never over the cells, keep the row's height when hidden (`visibility: hidden`), and come from a pure `edgeCues(scrollLeft, clientWidth, scrollWidth)` with 1 px tolerance.
- **Trend badge:** `<button type="button" class="trend trend-<label>" aria-describedby="trend-tip-<key>">` with `<span aria-hidden="true">` symbol (growing ▲, declining ▼, stable ■, new ✦, churned ✕) and `<span data-testid="trend-<key>">label</span>` (its text stays exactly the label); no `title`; a sibling `<span role="tooltip" id="trend-tip-<key>">` shown on hover, focus-visible and tap, closed with Escape, kept open while hovered; colors in text/status tokens with contrast measured on `--surface-1` and the hover background.
- **Unchanged:** the drill-down stays below the table at full width; `SkeletonTable` gains an opt-in `variant="customers"` (same layout and a reserved mirror/cue row), other callers unchanged; test ids stay unique.
- **Tests:** `edgeCues` and the trend symbol map unit-tested; DevTools at 1920/1440/1366/1280/1024/390 px in both themes: page `scrollWidth ≤ clientWidth`, trend visible, cues and mirror as specified, focus scroll, figures equal SQL.

## Reconciliation

Serves: R14, AC05.

- `reconcile-erpnext` runs daily (Q6). It can also be run on demand with `select internal.trigger_reconcile();` in the SQL editor, which makes a pg_net call with the Vault secret.
- It first reads one consistent snapshot of the store (`public.reconciliation_snapshot(from, to)`, one SQL statement: the invoices cursor, Source A invoices dated in the period, keys with a queued message, open quarantine keys, dead-lettered keys), **then** fetches through the adapter (`fetchSubmittedDocuments(company, from, to)`) `name`, `modified`, `posting_date` and `base_net_total` of every submitted (docstatus 1) invoice of the company in the period (default: the validation period, 2026), in pages of 500 keyed on `name`. In that order, a document that changes in between is newer than the snapshot's cursor or still queued, so it is `in_flight`, never `unexplained`.
- It compares document by document, in integer cents. A document on one side only compares against 0 (e.g. a stored invoice cancelled in ERPNext and not yet processed).
- `reconciliationService.reconcile` (pure) classifies; `public.finish_reconciliation_run` writes the run and its results in one transaction. A run that can't reach ERPNext is recorded as `failed` with no results.
- Each difference is classified:

  | Class | Meaning |
  |---|---|
  | `in_flight` | a message for it is pending, or ERPNext's (`modified`, `name`) is after the invoices cursor (no cursor yet: everything) |
  | `quarantined` | the invoice is in open quarantine |
  | `dead_lettered` | the invoice is in `dead_letter` |
  | `unexplained` | anything else |

- Only `unexplained` is an alarm. **AC05 passes when a run reports no `unexplained` difference.** Differences explained as in flight, quarantined or dead-lettered are expected, not failures.
- A per-month summary row (`class = 'summary'`, `source_doc_id` null) stores the ERPNext total and the stored total; the run stores both totals for the period and the count of `unexplained` rows. Classes are checked in the table's order, first match wins.
- Schedule: `cron.schedule('reconcile-erpnext', '0 6 * * *', 'select internal.trigger_reconcile()')`, daily at 06:00 UTC.
- Reconciliation covers Source A only. Source B needs none: the newest file replaces all of its data (BR10).

Rationale: Diffing document by document can name the invoice behind a monthly gap and keeps two opposite errors from cancelling out in the sum, while classifying gaps as in flight, quarantined or dead-lettered avoids false alarms. With about 200 invoices, fetching the full list costs the same call polling already makes.

## Dashboard, API and access

Serves: R08, R09, R10, R11, R12, R13, R19, AC10, AC12, AC32, US01–US06.

- Next.js on Vercel. The pages are:
  - revenue: monthly totals and a per-customer table with trend
  - quarantine
  - sync health: last successful sync per source, newest export date, consumer heartbeat, oldest pending message, DLQ count, reconciliation status
  - drill-down (P2)
- API routes, all GET, each a thin handler calling a service: `/api/revenue/monthly`, `/api/revenue/customers`, `/api/revenue/documents` (R12, P2), `/api/quarantine`, `/api/freshness`.
- Errors use Problem Details (RFC 9457):

  | Status | When |
  |---|---|
  | 400 | invalid query parameters |
  | 401 | no session |
  | 403 | session not on the allowlist |
  | 405 | every other method, with `Allow: GET` |
  | 500 | unexpected error |

- Every service queries Postgres with the signed-in user's session, so RLS is the security boundary. The dashboard holds only the publishable key; the service-role key never reaches it. (The temporary T10 deviation, service-role reads in local `next dev`, ended with T22 on 2026-10-19.)
- Readable in both themes: every text on the dashboard, chart tooltips included, uses the theme text tokens (`--text-primary`, `--text-secondary`), never a series color or a library default, so it keeps at least 4.5:1 contrast (WCAG AA) on its surface in light and dark mode (R16, AC20; T24). Native form controls follow the theme through `color-scheme: light dark` on `:root`, so the browser draws date-picker icons, select arrows and scrollbars in the theme's colors instead of its light defaults (R16, AC21; T25). Revenue figures carry the strongest visual weight: in the chart tooltip the value is the largest, boldest text, set in a neutral tag (`--surface-0` background, `--border` outline; no series color since R19, where blue means ERPNext); the month and invoice count are secondary text.
- Freshness is honest: a red banner shows when the consumer heartbeat is older than 5 minutes, the oldest pending message is older than 10 minutes, the DLQ is not empty, or reconciliation found `unexplained` differences. A fresh poll time can never hide stale figures.
- Access (R11, P2):
  - Supabase Auth with Google is the only provider; email and anonymous sign-in are disabled.
  - `is_allowlisted()` is `SECURITY DEFINER STABLE SET search_path = ''`. It requires the session's provider to be Google and the caller's Google identity (`auth.identities`, provider `google`, `user_id = auth.uid()`) to carry an email in `internal.allowlist` (Q5: the owner only; the test account is deliberately left off to prove the denied path). It never trusts the JWT's top-level `email`: that is `auth.users.email`, which the user can change (T22 adversarial review). The allowlist rows are written by `scripts/ops/set-allowlist.ts` from `ALLOWLIST_EMAILS`, never by a migration, so no email is in the repository.
  - Every table in `public` has RLS on, with only a SELECT policy `to authenticated using ((select internal.is_allowlisted()))`.
  - INSERT, UPDATE and DELETE are revoked from `anon` and `authenticated`. EXECUTE on every function in `internal` is revoked from `PUBLIC`, `anon` and `authenticated` and granted only to `service_role`.
  - The one exception in `internal` is `is_allowlisted()`, which RLS policies must be able to evaluate. It is granted to `authenticated` only (with USAGE on the schema) and returns a boolean about the caller. Since `internal` is not in the API's exposed schemas, it can't be called as an RPC either.
  - Three read-only functions in `public` are granted to `authenticated`: `app_access()` (the caller's own allowlist answer, used to pick the dashboard or the access-denied page), and the sync health wrappers `app_queue_metrics()` and `app_test_switch()`. The two wrappers are SECURITY DEFINER, so each checks `is_allowlisted()` itself and returns nothing (or `false`) otherwise.
  - Sign-in flow: `POST /auth/login` → Google → `GET /auth/callback` (PKCE code exchange) → `/`; `POST /auth/logout`. A Next.js `proxy.ts` refreshes the session cookies on every request and sends pages to `/login` (no session) or `/denied` (not allowlisted). Data routes answer 401 or 403 in Problem Details themselves.
  - A user who isn't allowlisted sees the access-denied page and gets no rows (AC10).

Rationale: The database is the gate, not the UI: tables get SELECT-only policies, and EXECUTE is revoked because Postgres grants it to everyone by default, so without the REVOKE anyone with the public key could call `apply_record` over RPC; the "Before User Created" hook stays an optional extra because Supabase's docs and pricing page disagree on whether the free plan has it. The red banner checks the consumer too, because "last successful sync" only describes polling, and a stopped consumer would otherwise leave stale figures under a green timestamp.

## Dashboard responsiveness (R17)

Serves: R17, AC22–AC25; keeps R10, R11, AC10.

**Diagnosis (Chrome DevTools, 2026-10-19).** Every data call waits on round trips to Supabase made one after another, not on data volume or on ERPNext (the dashboard only reads Postgres):

| Route | Sequential round trips today | After |
|---|---|---|
| `/api/revenue/monthly` | 7: proxy `getUser`, route `getUser`, `app_access`, the view, then the as-of reads (`sync_run`, `source_file`, `source_file`) one by one | 1 |
| `/api/revenue/customers` | 8: the three auth steps, the filtered view, the whole history, the three as-of reads | 1 |
| `/api/freshness` | 6: the three auth steps, then the as-of reads in series inside a parallel batch | 1 |
| `/api/quarantine` | 4 | 1 |
| `/api/revenue/documents` | 5: the three auth steps, documents, then their lines | 2 |
| page navigation (proxy) | 2: `getUser`, then `app_access` | 1 |

One round trip is about 250–600 ms from Brazil to us-east-1 locally and a few to tens of milliseconds from Vercel `iad1` (same region as the database) in production.

**Design: one parallel batch per request, nothing cached, the access decision unchanged.**

1. **Data routes open the session, then check access in parallel with the work, and decide after.**
   - *Open (no network when the token is valid):* `userClient()` and `getClaims()` run inside the try that maps to 500. `getClaims()` refreshes an expired token (writing the cookies before it resolves) and then verifies the token's signature locally against the project's ES256 key set (cached 10 minutes; fetched once per cold instance). No session (`getClaims()` returns `{ data: null, error: null }`), a sign-out-class error, or a non-Auth error thrown while decoding or verifying the token locally (a malformed or forged token is unverifiable) → **401 at once, without starting any database query**, so a forged cookie costs no database work and logs nothing. One rule (`isSignedOutError`) classifies Auth errors for both `getClaims()` and `getUser()`: sign-out is `AuthSessionMissingError`, `AuthInvalidJwtError`, or an `AuthApiError` that carries a `code` on a 4xx other than 429, unless that code is a rate-limit or outage code (`over_*_rate_limit`, `request_timeout`, `hook_timeout*`, `unexpected_failure`); so a malformed refresh token (Auth 400 `validation_failed`) or a signed-out session (403 `session_not_found`) is 401 and sends pages to `/login`, which itself renders. Every other error → 500, an outage never reported as a sign-out: an `AuthApiError` without a code (the gateway's 401 "Invalid API key", a key-set fetch 404), 5xx, 429, status 0 (unreachable), `AuthRefreshDiscardedError` (409) and anything unrecognised. *(Round 3: the first rule listed seven codes, so a garbage refresh token gave 500 everywhere, `/login` included.)* Auth itself may still be called on this path (refreshing an expired cookie, fetching the key set for an unknown `kid`, or `getUser` for an HS-signed or kid-less token); the project signs with ES256 and a `kid`, checked before relying on it. *(Round 2, after the code review: the first version used `getSession()`, which checks nothing in the cookie, so a forged cookie made every handler run.)*
   - *Batch:* with a session, three things start together under `Promise.allSettled`: `getUser()` (Auth confirms the session still exists, so signing out takes effect on the next request), `app_access()` (the allowlist) and the route's handler (`Promise.resolve().then(() => handlerFor(client)(request))`, so a synchronous throw is also caught). Handlers are read-only.
   - *Decide:* `decideAccess(user, allow)` is a pure function over the two settled results, with a unit-test table: a rejected or non-sign-out `getUser` → `error`; no user → `signed-out` (whatever `app_access` returned; its error is ignored); a rejected or failed `app_access` → `error`; anything but `true` → `denied`; otherwise `allowed`. `guarded` maps `error` → 500, `signed-out` → 401, `denied` → 403, and only for `allowed` looks at the handler: rejected → 500 Problem Details, otherwise its response. Access always wins: a signed-out or denied caller never sees the handler's body or status. The proxy reuses `decideAccess` and `pageRedirect`.
   - *Why the discard matters:* a signed-out user's access token stays a valid JWT until it expires (1 hour), and PostgREST and RLS check only its signature, expiry and the allowlist, not whether the session still exists. So for a replayed signed-out session the handler does read rows; only the discard keeps them out of the response. For an account off the allowlist RLS returns no rows anyway.
2. **The proxy leaves data and auth routes alone; pages get one check, and in-app navigation a local one.** The proxy matcher does not include `/api/*` and `/auth/*`: those routes open the session themselves (point 1, and the auth handlers). A full page load (a document request) opens the session as in point 1 (no valid session → `/login` without calling `app_access`; an error → the page fails), then runs `getUser()` and `app_access()` in parallel and routes with the same precedence (`decideAccess`, then `pageRedirect`). An in-app navigation or prefetch (a request whose `Sec-Fetch-Dest` header is present and is not `document`; Next strips the `rsc`/`next-router-*` headers and `_rsc` before the proxy runs, so those can't be used; a missing `Sec-Fetch-Dest` gets the full check) only opens the session locally: no valid session → `/login`; otherwise the page shell is served without asking Auth or the allowlist. `/login` and `/denied` always get the full check, because their content depends on the decision. A client that forges `Sec-Fetch-Dest` only receives the shell, the same for everyone. This is safe because pages render no data on the server (the shell is the same for everyone), and the data routes stay the authoritative gate: their 401/403 send the browser to `/login` or `/denied` (point 4). It removes the round trip that sat between the click and the page (300–780 ms locally). The session-opening code is one shared helper used by both the proxy and the data routes.
3. **Services issue their independent reads together.**
   - `readSourceDates` runs its three reads with `allSettled`. If `source_file` is missing, both of its reads are ignored (`sourceBAvailable: false`). The third read (latest ingest) is used only when the second found a file, and its error is ignored when there is no file. Any other error fails the request, as today.
   - The revenue service reads the view and the as-of dates together.
   - The customer service reads the whole per-customer history once, together with the as-of dates, and filters it in memory **before** aggregating: months by `YYYY-MM` string within [from, to] inclusive, exact `source`, exact `customer_key`. The trend and the customer list still use the unfiltered history. The single read keeps `ensureComplete`; past PostgREST's `max_rows` (1,000 rows of customer × month × source) the route fails closed with 500, within R17's volume bound.
   - The freshness service starts the demo test-switch read with the rest; if the switch is on, it throws `InjectedFailureError` before looking at the other results.
   - Documents stay two steps: the lines depend on which documents matched.
4. **No caching anywhere.** Every data response, success or Problem Details (401, 403, 405, 400, 500), carries `Cache-Control: no-store`; no Next.js data cache, CDN cache or client cache is added. Pages keep loading data in the browser through `/api/*`, so every call stays visible in DevTools. `fetchJson` sends a 401 to `/login` and a 403 to `/denied`, so a page shell served from the router cache can never show data the route refused.
5. **Measurable.** Allowed data responses carry `Server-Timing: app;dur=<ms>` (metric name only, no description; not sent on 401/403, so timing doesn't reveal how much a refused caller could see). Each page sets `data-ready="true"` on `<main>` once every data element it shows is rendered, and `data-page="<route>"`, so the agent measures click → `main[data-page=<target>][data-ready="true"]` through `evaluate_script` (waiting on the target page, never on the page being left) (section "Agent-driven UI verification").
6. **Regions.** The Vercel functions run in `iad1` (Washington, D.C.), next to the Supabase project in us-east-1; this is the deployment's recorded region. Where the proxy runs is checked during measurement.
7. **Cold start (Q9) is not part of this plan.** No keep-warm job is added; the plan does not depend on the answer.

**Tests.** `decideAccess` and `pageRedirect`: a unit-test table over every combination. `guarded`: the handler starts only with a session; with a stub handler that returns data, a signed-out `getUser` (session missing, the AC24 replay) gives 401 and a `false` allowlist gives 403, both without the stub's data in the body; a rejecting handler with an anonymous caller gives 401. **One round trip, proven:** the fake Supabase client gets a deferred mode that records each `from` and `rpc` call as issued when it is awaited (`then`), not when it is built, and resolves none until released; `guarded` is tested with its own deferred stubs, not the fake; per route, the test asserts the whole expected set was issued before any was released (documents: exactly two steps). Customer service: in-memory filtering gives the same rows, totals, options and trends as the SQL filter did, and a customer with revenue only outside the range is absent. `readSourceDates`: missing table, no file, file present, and an error in each read. Per endpoint, the happy-path and failure-path integration tests assert `Cache-Control: no-store`.

**Known limitations.** A signed-out caller replaying cookies whose access token hasn't expired (it has a valid signature) makes the route run its queries before being refused; the rows are discarded, never returned: database work, not a leak. A signed-out or denied user navigating inside an already open tab sees the page shell (no data) for a moment before being sent to `/login` or `/denied`. After a 401 the user lands on `/login` and, once signed in, on `/`, not on the page and filters they had. A forged token with an unknown `kid` costs two Auth calls per request (the key-set refetch, then `getUser`, which rejects it), never database work.

**Not chosen:** moving data loading into server components (would hide the calls from the DevTools check); caching figures or the allowlist answer (stale numbers or late revocation, against R10 and R11); trusting a locally verified token alone (`getClaims()`) in data routes (a signed-out token would keep working until it expires, against AC24); a database function per endpoint (more SQL to review for a gain the parallel batch already gives).

Rationale: Each route asks all its questions (identity, allowlist, data, as-of date) at once and answers only once it knows the caller may see the result; for a signed-out user whose token is still valid RLS still returns rows, so only the discard protects them, which is why the decision order is fixed and tested. Nothing is cached, so figures still come from the database on every request and sign-out takes effect on the next one.

## Loading feedback (R18)

Serves: R18, AC26–AC30.

1. **One loading vocabulary, no new dependency.** In `app/_components/`: `load-state.ts` (pure: `regionReady`, `pageReady`, `isSameRequest`, unit-tested in `tests/ui/`), `skeleton.tsx` (`SkeletonChart`, `SkeletonTable`, `SkeletonCards`, `BusyMark`: shapes only, `aria-hidden`, no text, no test id) and `data-region.tsx` (`DataRegion`, `InlineRetry`). `DataRegion` wraps one region: its container carries its own `data-ready` and `aria-busy` while loading, keeps its last content height as `min-height` while reloading, and has `tabIndex={-1}`; an always-mounted, visually hidden `role="status"` sibling outside the busy container goes '' → "Loading <what>…" → "<What> loaded". On failure the status is cleared and an error box (`role="alert"`, "<What> could not be loaded.", a "Try again" button) is the only announcement; it never renders "—", 0 or an empty table in place of data. Placeholders use a new `--placeholder` token (light `#76756f`, dark `#807f79`; at the faded end, blended at 0.95 opacity, 3.84 / 4.09 in light and 4.33 / 4.04 in dark against `--surface-0` / `--surface-1`); the spinner uses `--text-muted`. The only animation is an opacity pulse between 1 and 0.95, and the token values are chosen so that even the faded end keeps ≥ 3:1 (checked in both themes against both surfaces); under `prefers-reduced-motion: reduce` it is `none` and the static shapes stay visible.
2. **Every data region owns its load.** Revenue: the figures region (monthly + the sync-health banner) and the "data as of" line; Customers: the table and the drill-down; Quarantine: the list; Sync health: the cards. "Try again" sets that region to loading in the click handler (the button disappears, so further presses are impossible), moves focus to the region container, and re-runs only that request. The page's `data-ready` is `pageReady(...)` of its regions: `"error"` if any failed, `"false"` if any loads, `"true"` otherwise; every data page's `<main>` also has `data-page="<route>"`. On Revenue a failed "data as of" shows "could not be loaded" with an `InlineRetry` (`button.link`, same line height), never "—", which keeps meaning "never synced".
3. **Navigation feedback.** Each nav link renders a child `NavPending` that calls `useLinkStatus()`; while pending the link shows a dashed `--series-1` underline and an inline spinner, with no animation delay. There is no route `loading.tsx`: the pages are static client components, so a prefetched navigation paints the page's own placeholders at once (which satisfies AC26), and a non-prefetched one is only held by the proxy's local session check (R17 point 2).
4. **Filters.** Customers keeps `lastOptions` (the last loaded customer list); while loading it renders those, plus, if the selected customer isn't among them, one option for it with its last known name or its key. Apply or Reset with `isSameRequest(next, applied, state)` does nothing; otherwise the click handler sets the table region to loading and marks the control used busy (`aria-busy`, a `BusyMark` spinner, label unchanged, fixed `min-width`, never `disabled`, so focus stays). Last request wins (the existing guard). Quarantine applies its selects on change, with a `BusyMark` of reserved width at the end of the filter row. The drill-down is keyed by `${customer}|${month}`, so a new selection mounts in loading in the same render and never shows the previous documents.
5. **Filter row (AC31).** Every filter control shares one height (`--control-height`, 34 px) with `box-sizing: border-box`, so labels line up whatever the control type (a month field is taller than a select by default). Apply and Reset sit in a `.filter-actions` group that never wraps internally, so the group moves to the next row as a whole. The busy spinner is positioned inside the button's own right padding (`position: absolute`), so a busy button keeps its natural width; there is no `min-width`. *(Replaces the T27 `min-width: 6.5rem`, which made the buttons wide enough to push Reset to a second row.)*
6. **No layout jump.** On Revenue the sync-health banner is the first child of the figures region, and that region leaves loading only when both monthly and freshness have settled, so banner and figures appear together; a failed freshness shows no banner. Fail-closed: when the monthly figures fail but freshness loaded with alerts, the region still renders the sync-health banner, right above the error box, so the alerts never leave the screen because another load failed. The chart placeholder has the chart's size (`.card > .chart`, 320 px); a reload keeps the region's last height until the new content renders.

**Verification** (DevTools, with network emulated as "Slow 3G" so loading is observable): (1) a `MutationObserver` installed before the click records any figure test id inside a `.data-region` element whose `data-ready` is `"false"` (the `region-*` test ids and Revenue's "data as of" span; not `<main>`, whose `data-ready` is the page's aggregate and is `"false"` while any region loads) — the list stays empty; (2) `getBoundingClientRect().top` of the heading, the filters and the banner during and after loading — 0 px; (3) a performance trace from the click to the first frame with the link pending ≤ 100 ms, median of 3; (4) blocking `/api/revenue/customers`, `/api/freshness` and `/api/revenue/documents` shows the error box with "Try again" and `data-ready="error"`; (5) emulated `prefers-reduced-motion: reduce` → `document.getAnimations().length === 0` with placeholders visible; (6) the `--placeholder` contrast computed in both themes.

Rationale: One loading vocabulary (skeleton, busy region, error with "Try again") makes behavior identical on every page and testable in DevTools, and each region loads and fails on its own, so a failed "data as of" line leaves the figures in place.

## Read-only toward sources

Serves: BR09; constitution principle 4.

The ERPNext adapter used by the system implements GET methods only, and the production API key belongs to a user whose role has read permissions only. Nothing in this version writes to any source.

Rationale: The constitution allows draft write-back behind an approval step, but this version does not use it; read-only is enforced twice, with no write methods in the adapter and a read-only API user. The seed uses a different key and a different tool (see "Tools outside the system").

## Scheduling and runtime limits

Serves: R01, R03, R13, R14; constitution "Runtime limits".

| Job | Schedule | Budget |
|---|---|---|
| `erpnext-poll` | every 5 min (Q3) | stops at 100 s of 150 s |
| `invoice-consumer` | every 1 minute | ≤10 messages, vt 180 s |
| `legacy-ingest` | every 5 minutes | one file, ≤5,000 rows |
| `reconcile-erpnext` | daily (Q6) + on demand | a few ERP pages |
| cleanup (SQL only, not an Edge Function) | daily | trims `cron.job_run_details` and `net._http_response` |

- Every schedule is a `cron.schedule(...)` call in a migration. Scheduling the same job name again replaces it, so reapplying migrations after a pause restores everything. Function URLs and the cron secret come from Supabase Vault.
- Invocations come to about 61 thousand per 30-day month: consumer 43,200, legacy-ingest 8,640, poll 8,640 (every 5 minutes, Q3) and reconciliation 30 (daily, Q6). Webhooks add to that. The free quota is 500 thousand (confirmed on the pricing page).
- Throughput is bounded by the constitution's 10 messages per consumer run, which is 600 invoices per hour at one run per minute. That is enough for this lab. See "Known limitations" for a bulk import.

Rationale: The free Supabase plan pauses a project after 7 days without use and pg_cron has been reported not to resume on its own; since every schedule is an idempotent migration, reapplying them restores it. The daily cleanup exists because pg_cron never trims its own history.

## Dependencies

Serves: constitution "No new dependency enters without an explicit justification".

| Package | Why |
|---|---|
| `next` 16.4.2, `react` 19.3.1, `react-dom` 19.3.1; `@types/react`, `@types/react-dom` 19.3.0 (dev only) | The dashboard stack the constitution chose; the type packages let the app's `tsconfig.next.json` type-check JSX. |
| `@supabase/supabase-js`, `@supabase/ssr` 0.12.7 | Database access with the user's session (RLS), and Google sign-in cookies in Next.js (session cookies, PKCE code exchange, refresh in `proxy.ts`). |
| `jest`, `@swc/jest`, `@swc/core` | Jest is the constitution's test runner. `@swc/jest` (with its required `@swc/core`) only strips types so Jest can run `.ts`, the same way Node and Deno run it. |
| `csv-parse` 7.0.3 | Strict RFC 4180 parsing (quoted fields, embedded commas). A hand-written parser would be the riskiest code in Source B. `src/core` doesn't import it: the adapter receives `parse` from `csv-parse/sync` (Jest, Node) or `npm:csv-parse@7.0.3/sync` (the `legacy-ingest` Edge Function), and owns the parser options, so both runtimes parse identically. |
| `recharts` 3.10.1 | Monthly revenue charts. |
| `supabase` (CLI, dev only) | Migrations (`db push`), Edge Function deploys and the local stack the SQL integration tests run against. |
| `pg`, `@types/pg` (dev only) | The SQL integration tests connect to the local Postgres directly, to switch roles (`anon`, `authenticated`) and to run concurrent transactions; `supabase-js` can't do either. Also used by `scripts/ops/set-vault-secrets.ts`, which writes the Vault secrets the cron jobs read. Never imported by `src/` or by Edge Functions. |

Edge Functions import `supabase-js` through `npm:` and call SQL functions for every multi-step write, so no Postgres driver is added.

Rationale: Each package has one job, and `src/core`, where the business rules live, depends on none of them. The CSV parser is a library on purpose, because quoting rules are exactly where hand-written parsers break.

## Testing by breaking things

Serves: AC01–AC19; constitution "Quality".

- Unit tests (Jest) cover every business rule, BR01 to BR10:

  | Rule | Unit under test | What the tests pin down |
  |---|---|---|
  | BR01 | `validation`, ERPNext adapter | cancelled (docstatus 2) and tombstones give the cancelled outcome; drafts are never requested |
  | BR02 | `validation` | ±0.01 tolerance at the boundary; Source B line = `QTY × UNIT_PRICE` |
  | BR03 | `validation`, both adapters | each missing field; wrong format per source; `02/30/2026`; dates outside the period |
  | BR04 | `validation` | non-USD currency |
  | BR05 | `normalize`, `validation` | case, punctuation and spacing; suffixes kept (`Acme Co` ≠ `Acme Inc`); unknown name |
  | BR06 | Source B grouping | conflicting invoice-level columns; a repeated row dropped when `INV_TOTAL` matches it counted once, kept when it matches both, `TOTAL_MISMATCH` otherwise |
  | BR07 | `revenue` aggregation | month bucketing by invoice date; credit notes negative in their own month |
  | BR08 | `trend` | each rule in order; previous 3 ≤ 0; exact thresholds in cents; the 18 customers of `scripts/seed/README.md` at as-of 2026-10-16 |
  | BR09 | ERPNext adapter | the client exposes no write method and refuses non-GET requests |
  | BR10 | Source B snapshot | invoices missing from the newest file become tombstones; an older file is rejected; same content as the newest is a no-op that updates the export date |
  | order | `validation` | one reason code per invoice, in the order BR03 → BR04 → BR06 → BR02 → BR05 |

- `IncrementalSync` tests come **first**: the agent writes them against a fake adapter (a tie at a page boundary, the 65-minute overlap replay, a failure mid-run, the cursor never moving back, the deleted-documents stream), and the class is implemented against them, then reviewed by two adversarial reviewer agents, one for correctness and one for contract and test coverage (principle 6). The same review applies to the consumer with the idempotent upsert and to validation/quarantine.
- SQL integration tests run from Jest against the local Supabase stack. They cover the version guard (including two concurrent `apply_record` calls where the newer commits first and must win), each outcome transition, the DLQ move (with and without an older valid version, which must leave the figures as `PROCESSING_FAILED`), `enqueue_page` skipping and the forward-only cursor, and the grants (an RPC with the user's token or the anon key gets permission denied).
- Every endpoint has a happy-path and a failure-path integration test.

| AC | How it is provoked | Pass when |
|---|---|---|
| AC01 | Run poll and consumer twice with no changes | invoice count and every monthly total identical |
| AC02 | Cancel and amend an invoice in ERPNext, submit the amendment | `sync_run.fetched` lists only those two (plus the overlap window); original out, amendment counted once |
| AC03 | `test_switch` makes the consumer throw after the 3rd message | after 180 s every invoice of the batch stored exactly once |
| AC04 | Ingest `data/unit_b_export_2026-10-16.csv` | each planted error in `data/legacy_unit_b.README.md` is in quarantine with its one expected reason code, none in figures |
| AC05 | Run reconciliation | no `unexplained` difference |
| AC06 | The 4 seeded drafts | none counted |
| AC07 | Run `trend` on both sources with as-of fixed at 2026-10-16 | every customer matches `scripts/seed/README.md` |
| AC08 | Edit in ERPNext with the webhook on, then off | in figures within 2 min; within 6 min (5-minute poll, Q3, plus 1) with it off |
| AC09 | POST to the webhook with no or a bad signature | 401 Problem Details, queue depth unchanged |
| AC10 | Sign in with a non-allowlisted and an allowlisted account; call non-GET routes; try table writes and `internal` RPCs with the user's token and the anon key | denied page and no rows; 405; all writes and RPCs rejected |
| AC11 | Point `ERPNEXT_URL` at a stub returning 502 | last successful sync unchanged; restored URL updates it |
| AC12 | Expand a customer-month | listed documents add up to the figure |
| AC13 | Enqueue a malformed message | in DLQ after 5 attempts (Q4), not retried |
| AC14 | Upload the newest file's content again under a newer export date; upload a wrong-header file and an empty file | figures unchanged, newest export date updated; both bad files rejected whole |
| AC15 | Add an unknown customer to the mapping (new migration) | its records leave quarantine and enter figures |
| AC16 | Upload a newer Source B export where a valid invoice now has a wrong total, or remove an ERPNext customer's alias from the mapping | in quarantine, old amount gone from figures |
| AC17 | After `…10-16.csv`, ingest `…10-17.csv` (UB-26001, valid, and UB-26010, quarantined, removed), then `…10-15.csv` | UB-26001 leaves the figures; UB-26010's quarantine entry is closed as `removed_from_export`; the 10-15 file is rejected whole and nothing changes |
| AC18 | Query the canonical tables per customer after both sources sync | each customer's revenue = valid Source A invoices + valid Source B invoices (expected Source B totals in `data/legacy_unit_b.README.md`) |
| AC19 | Ingest `…10-16.csv` | the export-duplicate row counts once and isn't quarantined; the invoice with two real identical lines counts both |

Rationale: AC03 uses a test switch instead of killing the worker by hand, because an Edge Function cannot be killed mid-batch with precision. AC16 cannot be provoked by editing a submitted ERPNext invoice (amount, currency and customer are frozen after submit), so it uses a newer CSV or the removal of an alias.

## Agent-driven UI verification (Chrome DevTools MCP)

Serves: R08, R09, R10, R12, R17; constitution "Quality" (every UI change is verified through the Chrome DevTools MCP).

**When it runs:** at the end of every task that changes a page or an API route the page calls (T10 onward), before the task is reported done. It runs again before a demo (`docs/DEMO.md`).

**What the agent checks**, on the real page in Chrome, driven through the Chrome DevTools MCP:

| Check | How | Pass when |
|---|---|---|
| Console | `list_console_messages` after the page settles | no error and no unhandled rejection; warnings listed in the report |
| Network | `list_network_requests`, then `get_network_request` for each data call | every `/api/*` call returns 2xx, with a Problem Details body only on deliberate failure tests |
| Values against the database | read the rendered figures (`take_snapshot` / `evaluate_script`), run the matching `SELECT` on the canonical tables | every figure on screen equals the query, to the cent |
| Latency (R17) | `evaluate_script`: click the nav link, filter or month figure, time until `main[data-ready="true"]` with the new data; 3 runs, median; `Server-Timing` read from each data response | AC22 (production, ≤ 1 s) or AC23 (local, ≤ 1.5 s, every route compiled once; dev mode fires each fetch twice, which is expected and not a retry) |
| Evidence | `take_screenshot` | screenshots saved in `docs/demo/` with the task ID and what they show |

The report of each run lists the page, every check with its result, and the screenshots.

**What the agent can't judge**, which is the human's job:

- whether a chart misleads even when every number is right. For example, October looks like a drop because the month is incomplete, the same trap BR08 avoids;
- whether a label, an order or a grouping makes sense to a finance team preparing a board deck;
- whether the page answers the question the user actually has.

Rationale: The agent is good at machine-checkable facts (console, HTTP status, on-screen figure versus database) and catches what the eye misses, such as a 500 behind a spinner or a one-cent difference. It cannot tell whether a chart tells the right story, such as an October that looks like a drop only because the month is partial; that judgment stays with a human.

## Known limitations

Serves: no spec ID (operational limits, each with its next step).

- **Bulk imports are slow to drain.** A month-end Data Import of 20,000 invoices sends no webhooks and drains at 600 per hour, about 33 hours. There are two levers. Within the constitution, the consumer can run every 10 seconds, which gives 3,600 per hour at about 260 thousand invocations a month. Beyond it, AWS Lambda scales out on SQS.
- **A customer renamed in ERPNext gets a new ID.** The customer is named by its customer name. New invoices then go to quarantine as `UNKNOWN_CUSTOMER` until the mapping lists the new ID. This is fail-closed, but it needs a human.
- **No push alerts.** Problems show as a red banner on the dashboard. Paging someone is a next step.
- **The credit-note sign is not validated** (BR07, accepted 2026-10-18). Amounts are stored with the source's sign, so a credit note that arrives positive would add revenue instead of reducing it. The seed has no returns; the fix would be a sign rule with its own reason code.
- **IncrementalSync, from its adversarial review (2026-10-18).** Fixed: overlap livelock after an incomplete run (it now resumes exactly at the cursor), short-fraction cursors, a full page that doesn't advance, `startRun`/`finishRun` errors, `readCursor` errors, and tests for AC01, AC11 and a failed commit on page 2. Accepted as limitations:
  - after an `incomplete` run there is no overlap, so a transaction that commits late *behind a mid-backlog cursor* is caught only by reconciliation (R14);
  - after a `failed` run the overlap is applied again, so repeated failures in the middle of a backlog bigger than the window re-read it each time (slow, never wrong);
  - the 100 s budget is checked between fetches, so one fetch must be bounded: **T6 caps the ERP client's retries and timeouts so a single fetch takes at most ~40 s** (100 + 40 < the 150 s wall clock). Done in `pollService`: 15 s timeout per attempt, 2 attempts, backoff and `Retry-After` capped at 5 s, so the worst case is 15 + 5 + 15 = 35 s;
  - suggestion rejected: "the sync never commits a `last` behind the cursor" is wrong by design, because the overlap re-reads pages behind it; the SQL `enqueue_page` keeps the cursor forward-only.
- **Consumer, as built in T9 (2026-10-18).**
  - Until T13 there was no DLQ move (messages past 5 attempts were parked). Since T13 they move to `invoice_events_dlq`; the run's result counts them as `deadLettered` and the heartbeat's `parked` column holds that count. Nothing pages on it yet (see "No push alerts").
  - From the adversarial review (2026-10-18), fixed in migration `20261018193000`: the version guard compares with `COLLATE "C"`, `apply_record` refuses a `sourceVersion` that isn't `1|` or `2|` plus the fixed-width `modified` (a draft never reaches `invoice`), and the ERPNext adapter numbers lines by position in `idx` order, so a duplicate or non-integer `idx` can't break the `invoice_line` key.
  - `oldest_message_age` in the heartbeat is the age of the oldest message *read in that run*; messages hidden by backoff aren't seen, so it understates a backlog of failing messages.
  - The AC03 switch `consumer_throw_after_3` aborts the whole run after the 3rd message (it stands for the function dying), so the rest reappear after 180 s without counting an attempt. While the row is on, every run applies 3 and stops.
- **Consumer track (T7, T8, T13, T15, tombstones), 2026-10-18.**
  - A mapping change makes in-flight outcomes fail once (`40001`) and costs each such message one of its 5 attempts before it is retried with the new mapping.
  - An ERPNext tombstone (`3|`) outranks every later version of the same name; if ERPNext ever reused a deleted invoice's name, the new document would be refused as `stale` (ERPNext naming series don't reuse names).
  - The first mapping migration re-validates every invoice stored before it (196 in the cloud): about 20 consumer runs to drain.
- **Deleted stream (T14).** A cancelled invoice whose name is used again after deletion (not possible with ERPNext's naming series, only with a manually set name) would stay behind its `3|` tombstone. Drafts are skipped for exactly that reason (amendment names). The deleted stream always re-reads its overlap window, so more than ~20 s of fetching inside 65 minutes of deletions would never drain; with a handful of deletions a day, that is far off.
- **Validation and quarantine review (2026-10-18).**
  - A Source B reason code for a conflicting invoice depends on row order: invoice-level checks (BR03, BR04, BR02) read the first row; the other rows only feed the BR06 conflict check (row 1 EUR + row 2 USD gives `UNSUPPORTED_CURRENCY`; swapped, `CONFLICTING_DUPLICATE`). Always quarantined, with one code; figures unaffected.
  - After `PROCESSING_FAILED`, an ERPNext invoice stays out of the figures until a newer version arrives or it is re-enqueued; reconciliation reports it as quarantined.
  - Normalization strips punctuation without inserting a space ("A-1 Foods" = "A1 Foods"). The mapping decides, so nothing merges automatically, but aliases must be reviewed. A unit test fails on any normalized alias collision in the shipped mapping; an ambiguous mapping loaded at run time stops the consumer loudly (heartbeat with nothing processed, 500 Problem Details).
- **Webhook hints in the consumer (integration, 2026-10-18).** A hint that fails for a reason other than ERPNext being unavailable (raw upload, unexpected answer) is retried like any message; after 5 attempts it is dead-lettered, and because a hint has no version the DLQ fails closed, taking that invoice's current figures to `PROCESSING_FAILED`. Hints start fetching only in the first 60 s of a run, and after one unavailable fetch the run drops its remaining hints; polling picks them up.
- **Rebuild from scratch is a runbook, not a button:** reset the cursors, truncate the derived tables, and let polling and a re-upload of the files replay everything. Idempotency makes the replay safe.

## Mapping to AWS

Serves: no spec ID (portability reference).

| Here | AWS |
|---|---|
| Storage buckets `raw`, `legacy-uploads` | S3 (uploads trigger directly through S3 event notifications) |
| pgmq `invoice_events` and a hand-made DLQ on attempts | SQS with a native redrive policy (`maxReceiveCount` = 5) |
| `invoice-consumer` on pg_cron | Lambda triggered by SQS (batch size 10), scaling out on queue depth |
| `erpnext-poll`, `legacy-ingest`, `reconcile-erpnext` on pg_cron | Lambda on EventBridge Scheduler |
| `erpnext-webhook` | API Gateway and Lambda |
| Postgres with RLS, `internal` schema | RDS for PostgreSQL (RLS and grants work the same) |
| Supabase Auth (Google) | Cognito with Google federation |
| Supabase secrets and Vault | Secrets Manager |
| Next.js on Vercel | Vercel unchanged, or Amplify / CloudFront |

The visibility timeout stays longer than the consumer's run time. Short jobs stay on Lambda. Long jobs, such as OCR on large PDFs, would move to ECS Fargate workers scaled on queue depth.

Rationale: Three AWS services remove work done by hand here: SQS's native redrive policy replaces the hand-made DLQ, S3 upload events replace the 5-minute bucket scan, and Lambda scaling on queue depth lifts the consumer's throughput limit.

## Coverage matrix

| Spec ID | Section |
|---|---|
| R01 | Source A: incremental fetch |
| R02 | Source A: webhooks (P2) |
| R03 | Source B: export file ingestion |
| R04 | Canonical model and adapters |
| R05 | Customer resolution |
| R06 | Validation and quarantine; Idempotency and versioning |
| R07 | Idempotency and versioning; Queue, consumers and failures |
| R08 | Revenue and trends; Dashboard |
| R09 | Validation and quarantine; Dashboard |
| R10 | Source A: incremental fetch; Source B; Dashboard |
| R11 | Dashboard, API and access (P2) |
| R12 | Data model; Dashboard (P2) |
| R13 | Queue, consumers and failures |
| R14 | Reconciliation |
| R15 | Customer resolution |
| BR01 | Source A: incremental fetch; Validation; Idempotency |
| BR02–BR04 | Validation and quarantine |
| BR05 | Customer resolution; Validation |
| BR06 | Source B: export file ingestion; Validation |
| BR07 | Canonical model; Revenue and trends |
| BR08 | Revenue and trends |
| BR09 | Read-only toward sources |
| BR10 | Source B: export file ingestion; Idempotency (removed outcome) |
| EC01 | Source A: incremental fetch; Idempotency (cancelled outcome) |
| EC02 | Source A: webhooks; Idempotency |
| EC03 | Source A: incremental fetch |
| EC04 | Queue, consumers and failures |
| EC05, EC11 | Source A: incremental fetch |
| EC06, EC07 | Source B: export file ingestion |
| EC08 | Source B; Idempotency (resolve on valid) |
| EC09 | Customer resolution |
| EC10 | Idempotency (invalid outcome) |
| EC12 | Source A: incremental fetch (Deleted Document); Idempotency (cancelled outcome) |
| AC01–AC16 | Testing by breaking things |
| AC17 | Source B: export file ingestion; Idempotency; Testing |
| AC18 | Revenue and trends; Testing |
| AC19 | Source B: export file ingestion (repeated rows); Testing |
| US01–US03 | Revenue and trends; Dashboard |
| US04 | Validation and quarantine; Dashboard |
| US05 | Dashboard (sync health) |
| US06 | Dashboard (drill-down, P2) |

## Open points for the owner

None as of 2026-10-18. Every question (Q1–Q8) and every point raised by the plan reviews is decided in `SPEC.md` or `CONSTITUTION.md` and applied above.

## Tools outside the system

- ERPNext seed (`scripts/seed/`): a deliberate exception to the rule "no code before the ANALYSIS is approved", because it is a tool to populate and explore the ERP, not part of the system (which is why it calls the API directly, without the adapter).
- Development dependencies `typescript` + `@types/node`: only for `tsc --noEmit`; Node 24 runs `.ts` directly (type stripping), so the tsconfig uses `erasableSyntaxOnly` and nothing is compiled.
- Unit B export generator (`scripts/legacy/`, `npm run legacy:csv`): same exception as the seed; it generates `data/unit_b_export_2026-10-16.csv` (planted errors and repeated rows, AC04 and AC19), the snapshots `…2026-10-17.csv` and `…2026-10-15.csv` (AC17), the list of expected cases (`data/legacy_unit_b.README.md`) and the table of expected trends (`scripts/seed/README.md`, AC07), all from the same code, deterministically.
- Demo invoice (`scripts/seed/seed-demo.ts`, `npm run seed:demo`) and demo shortcuts (`scripts/demo/demo.ts`, `npm run demo:poll|demo:switch|demo:status`): same exception as the seed; they ensure a single submitted `DEMO-` invoice of USD 1,000.00 for scene (a) of `docs/DEMO.md` (without touching the `SEED-` invoices), trigger the poll, turn on the test switch and read the figures straight from the database as an operator.
