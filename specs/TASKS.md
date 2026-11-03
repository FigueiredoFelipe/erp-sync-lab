# Tasks

Small, ordered, each one verifiable. One task = one branch. Order: a thin end-to-end slice first (ERPNext → queue → consumer → table → page), then Source B, then the rest of P1, then P2. Critical pieces (IncrementalSync, idempotent consumer, validation) were tested first and passed two adversarial reviews before merge (constitution, principle 6).

IDs refer to `SPEC.md` (R = requirement, BR = business rule, EC = edge case, AC = acceptance criterion, US = user story). Cross-check: `ANALYSIS.md`.

## Thin slice (Source A only)

| ID | Task | Status | Covers | Delivered |
|---|---|---|---|---|
| T0 | Merge specs and seed into `main` | done | prerequisite | Specs, ERPNext seed and legacy CSV fixtures on `main`. |
| T1 | Supabase project and repository skeleton | done | Constitution "Stack", "Quality" | Jest (`@swc/jest`), Supabase CLI link/push, local stack for SQL tests, `.env.example`. |
| T2 | Minimal migrations | done | R07, R09, R13 | `public`/`internal` schemas, core tables, pgmq queues; RLS on, writes and `internal` EXECUTE revoked from `anon`/`authenticated` (SQL test). |
| T3 | ERPNext adapter (read-only) | done | R01, R04, BR01, BR09 | Keyset page fetch on `(modified, name)`, `toCandidate()`; GET-only HTTP client with a unit test for BR09. |
| T4 | IncrementalSync tests (before the class) | done | R01, EC03, EC05, EC11, AC01, AC11 | Tie on `modified` at page edge, 65-min overlap, cursor only forward, 100 s budget, ERP outage. |
| T5 | IncrementalSync implementation | done | R01, EC03, EC05, EC11 | T4 suite green unchanged; two adversarial reviews. |
| T6 | `erpnext-poll` and `enqueue_page` | done | R01, R10, EC05, EC11, AC02 (run log), AC11 | Transactional `send_batch` + forward-only cursor; pg_cron every 5 min; `internal.trigger_poll()`; 502 stub leaves "last successful sync" unchanged. |
| T7a | Minimal Source A validation | done | R06, BR01–BR04 | `validate()` applies BR03 → BR04 → BR02 with a single reason code; docstatus 2 → `cancelled`. |
| T9 | Consumer and idempotent upsert | done | R06, R07, BR01, EC02, EC04, EC10, AC01, AC03, AC06 | `internal.apply_record` with an atomic version guard; `invoice-consumer` (10 msgs, vt 180 s, per-message backoff); 196 invoices, USD 461,664.00, re-runs change nothing. |
| T10 | Revenue by month page | done | R08, R10, US01, US05 | Next.js page + `GET /api/revenue/monthly` and `/api/freshness`, Problem Details errors, 405 with `Allow: GET`. |
| T10a | UI verification through Chrome DevTools MCP | done | Constitution "Quality"; R08, R10 | No console errors, data calls 2xx, on-screen totals equal SQL to the cent (`docs/demo/T10A-VERIFICATION.md`). |
| T10b | Walkthrough script (not part of the public repository) | done | Constitution "Quality" | Three scenes: live sync, injected API failure, partial-month trap. |
| T10c | Mark the partial month | done | R08, US01 | Current month hatched and labeled "partial, through <date>"; T10a re-run passes. |

## Source B, full validation and mapping

| ID | Task | Status | Covers | Delivered |
|---|---|---|---|---|
| T7 | Full validation and normalization | done | R06, BR02–BR06 | Pure functions with unit tests; order BR03 → BR04 → BR06 → BR02 → BR05, one reason code. |
| T8 | Customer mapping (migration) | done | R05, BR05 | `internal.apply_customer_mapping(jsonb)`; 18 customers with Unit B aliases (SQL test). |
| T11 | CSV adapter | done | R03, R04, BR03, BR04, BR06, AC19 | Strict `csv-parse`, whole-file rejection, grouping by `INV_NO`, duplicate arbitration by `INV_TOTAL`. |
| T12 | `legacy-ingest` and full snapshot | done | R03, R10, BR10, EC06–EC08, AC04, AC14, AC17, AC19 | Insert-only bucket, one file per run, tombstones for missing invoices; README sequence end to end. |

## Rest of P1

| ID | Task | Status | Covers | Delivered |
|---|---|---|---|---|
| T13 | Dead-letter queue and `PROCESSING_FAILED` | done | R13, AC13 | `internal.dead_letter` in one transaction; poison message dead-lettered after 5 attempts. |
| T14 | Deleted documents in ERPNext | done | BR01, EC01, EC12, AC02 | `Deleted Document` stream with its own cursor → tombstones; manual AC02/EC12 procedure in `docs/ACCEPTANCE-NOTES.md`. |
| T15 | Revalidate on mapping change | done | R15, EC09, AC15, AC16 | `revalidate` messages for affected records; stale `mapping_version` results refused. |
| T16 | Source A reconciliation | done | R14, AC05 | `reconcile-erpnext` (daily + on demand) classifies each difference; no `unexplained` in normal state. |
| T17 | Revenue by customer, filters, credit notes | done | R08, BR07, AC18, US02 | `GET /api/revenue/customers` by source, customer and period; credit notes negative in their own month. |
| T18 | Quarantine and sync health pages | done | R09, R10, R13, US04, US05 | `/api/quarantine`, `/api/freshness`; health page with red banner conditions from the PLAN. |
| T19 | P1 acceptance run | open | AC01–AC06, AC11, AC13–AC19 | `specs/ACCEPTANCE.md` (one measured result per P1 criterion) not written yet. |

## P2

| ID | Task | Status | Covers | Delivered |
|---|---|---|---|---|
| T20 | Customer trend | done | BR08, AC07, US03 | `trend(monthlyCents, asOfDate)`; 18 customers match `scripts/seed/README.md` at as-of 2026-10-16. |
| T21 | ERPNext webhook | done (code) | R02, EC02, AC08, AC09 | `erpnext-webhook` checks HMAC on the raw body and only enqueues hints; 401 on bad signature. ERPNext-side Webhook not configured, so AC08 is not measured. |
| T22 | Google sign-in, allowlist, deploy | done | R11, AC10 | Google-only auth, `is_allowlisted()` + SELECT policies, services read with the user session, Vercel deploy. |
| T23 | Drill-down to source documents | done | R12, AC12, US06 | `GET /api/revenue/documents`; listed documents add up to the figure. |
| T24 | Chart tooltip contrast | done | R16, AC20 | Revenue leads the tooltip; ≥ 4.5:1 contrast in both themes. |
| T25 | Date-field icons in dark mode | done | R16, AC21 | `color-scheme: light dark`; native controls follow the theme. |
| T26a | Access: session, parallel batch, decision precedence | done | R17, R11, AC24 | `guarded()` runs `getUser`, allowlist and handler in one `allSettled` batch; `no-store` and `Server-Timing` headers. |
| T26b | Services: independent reads together | done | R17, R10, AC25 | Every service issues its reads before awaiting any (fake Supabase with deferred mode). |
| T26c | Pages mark when data arrived | done | R17, AC22, AC23 | `data-ready="false" \| "true" \| "error"` on `<main>`. |
| T26d | Measure and compare | done (local) | AC22–AC25 | Localhost flows 0.29–0.78 s (were 1.6–6.2 s), all ≤ 1.5 s (AC23). AC22 in production not measured. |
| T26e | Review round 2: local token check | done | R17, AC24 | `getClaims()` verifies the token locally; forged-cookie table → 401 with no query. |
| T27 | Loading feedback | done | R18, AC26–AC30 | Shaped skeletons without figures, pending nav link, busy buttons, per-region "Try again". |
| T28 | Responsive filter row | done | R16, R18, AC31 | Equal control heights, labels on one line, Apply/Reset kept together, checked 1920–390 px. |
| T29 | Monthly revenue by source | done | R19, AC32 | Stacked bars per source; 20 segments equal SQL to the cent. |
| T30 | Financial clarity between Sync health and Revenue | done | R20, AC33–AC37, Q10, Q11 | Reconciliation labeled "Unit A only"; valid revenue by source on both pages, equal to SQL. |
| T31 | Customers table keeps trend visible | done | R21, AC38–AC41 | Fixed customer/total/trend columns with scrolling months; checked at 1920–320 px in both themes. |

## Results kept for reference

T26d, localhost, routes compiled, median of 3, click → `data-ready="true"`:

| Flow | Before | After | AC23 (≤ 1.5 s) |
|---|---:|---:|---|
| Navigate to Revenue | 5.0–6.2 s | 0.58 s | ok |
| Navigate to Customers | 2.9 s | 0.78 s | ok |
| Navigate to Quarantine | ~2.8 s (API only) | 0.32 s | ok |
| Navigate to Sync health | 2.2 s | 0.38 s | ok |
| Source filter | 1.6–2.9 s | 0.30 s | ok |
| Date filter | 1.6–2.9 s | 0.29 s | ok |
| Drill-down | 1.6–1.8 s | 0.58 s | ok |

Server time per call (`Server-Timing`): 0.18–0.59 s, about one round trip to Supabase. Suite at T31: 1,225 tests (including SQL), typecheck clean.
