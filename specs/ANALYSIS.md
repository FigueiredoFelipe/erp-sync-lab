# Analysis

Cross-check of `SPEC.md` acceptance criteria against `TASKS.md` and the test suite. Test names are files under `src/` and `tests/` without `.test.ts`. "DevTools" means verified in the browser through the Chrome DevTools MCP, with the result recorded in `TASKS.md` or `docs/demo/`.

## Acceptance criteria × tasks × tests

| AC | Requirement | Tasks | Tests / verification |
|---|---|---|---|
| AC01 | R01, R07 | T4, T9 | `incremental-sync`, `consumer`, `consumer-e2e` |
| AC02 | R01, BR01, EC01 | T6, T14 | `deleted-stream`, `poll`; manual procedure in the ERPNext UI (cancel or amend an invoice, then check the stored state) |
| AC03 | R07, EC04 | T9 | `consumer-service`, `consumer-e2e` |
| AC04 | R06, R09, BR02–BR06 | T12 | `legacy-ingest` |
| AC05 | R14 | T16 | `reconciliation-service`, `reconciliation` |
| AC06 | BR01 | T9 | `consumer-service`, `consumer`, `consumer-e2e` |
| AC07 | BR08 | T20 | `ac07-trend`, `trend` |
| AC08 | R02 | T21 | manual procedure with the webhook in `docs/erpnext-webhook.md` |
| AC09 | R02 | T21 | `webhook-service`, `erpnext-webhook-handler` |
| AC10 | R11 | T22 | `access`, `data-routes-auth`, `auth-allowlist`; production sign-in check (`DEPLOY.md`, R5) |
| AC11 | R10, EC05 | T4, T6 | `incremental-sync`, `poll-service` |
| AC12 | R12 | T23 | `documents-route`, `customer-revenue` |
| AC13 | R13 | T13 | `consumer-e2e`, `dead-letter` |
| AC14 | EC06, EC07 | T12 | `legacy-ingest-service`, `legacy-ingest` |
| AC15 | R15, EC09 | T15 | `mapping-revalidate` |
| AC16 | R06, EC10 | T15 | `mapping-revalidate` |
| AC17 | BR10 | T12 | `tombstones-and-source-b`, `legacy-ingest` |
| AC18 | R04, R05, R08 | T17 | `customer-revenue`, `legacy-ingest`, legacy `adapter` |
| AC19 | BR06 | T11, T12 | legacy `adapter`, `legacy-ingest` |
| AC20 | R16 | T24 | DevTools (both themes) |
| AC21 | R16 | T25 | DevTools (both themes) |
| AC22 | R17 | T26c, T26d | not yet measured in production |
| AC23 | R17 | T26c, T26d | DevTools on localhost (table in `TASKS.md`) |
| AC24 | R17, R11 | T26a, T26e | `access`, `data-routes-auth`, `proxy`, `route-headers` |
| AC25 | R17, R10 | T26a, T26b | `problem`, `route-headers`, service tests |
| AC26–AC30 | R18 | T27 | `load-state`; DevTools with "Slow 3G" |
| AC31 | R16, R18 | T28 | DevTools at 1920–390 px |
| AC32 | R19 | T29 | `revenue-service`, `revenue-route`, `stack-geometry`; DevTools vs SQL |
| AC33–AC34 | R20, R14 | T30 | `freshness-service`, `freshness-route`; DevTools vs SQL |
| AC35, AC37 | R20, R18 | T30 | `compare`, `freshness-service` |
| AC36 | R20 | T30 | `revenue-service`, `revenue-route`; DevTools vs SQL |
| AC38–AC39 | R21 | T31 | `table-scroll-geometry`; DevTools at 1920–320 px |
| AC40 | R21, R16 | T31 | `trend-symbols` |
| AC41 | R21 | T31 | existing AC12, AC18, AC27–AC29, AC31 tests unchanged |

Every business rule has a unit test: BR01 (T3, T7a, T14), BR02–BR06 (T7, T11), BR07 (T17), BR08 (T20), BR09 (T3), BR10 (T12). Every requirement R01–R21 maps to at least one task (see the "Covers" column in `TASKS.md`).

## Gaps

- **T19 is open:** `specs/ACCEPTANCE.md`, a single measured run of every P1 criterion, does not exist. P1 criteria are covered by automated tests, but not re-run and recorded together.
- **AC02 and AC08** need actions in the ERPNext UI (cancel/amend; webhook latency). The procedures are written; no result is recorded. The ERPNext-side Webhook is not configured, so AC08 is not met in the deployed system.
- **AC22** (load time in production) is not measured; only the localhost counterpart (AC23) is.
- **UI criteria AC20, AC21, AC31** rely on browser checks, not on automated tests.
- **Q12** (very narrow screens, below 390 px) uses a provisional behavior.
