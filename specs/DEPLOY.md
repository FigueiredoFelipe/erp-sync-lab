# Release: commit and deploy

How a change goes from a task branch to production. Same method as the rest of `specs/`: requirements, plan, tasks, acceptance. Serves the constitution's Stack (Vercel + Supabase), "No secrets in the repository", "Cron schedules are defined in SQL migrations" and Quality (UI verified through the Chrome DevTools MCP).

Everything that can be done and checked through an MCP (Vercel, Supabase, GitHub, Chrome DevTools) is done that way; the few steps that need the project owner (signing in, Supabase Auth settings in the dashboard) are marked as owner actions.

## Requirements (D)

- **D1 — One path to production.** Production is the `main` branch. A task merges into `main` only after its tests pass and, for critical pieces, after the two adversarial reviews (constitution, principle 6). Merges and pushes happen only on the owner's request.
- **D2 — Commits.** Conventional Commits, one commit per task at least, specs updated in the same commit as the code they describe; constitution changes in a separate commit. Before every commit the staged diff is scanned for secrets and personal data (`.env` values, keys, emails).
- **D3 — Database first.** Migrations reach the cloud database before the code that depends on them. Every migration is additive or backward compatible with the code already in production, so the order "database, then functions, then app" never breaks the running system.
- **D4 — Edge Functions.** Deployed from the repository with the Supabase CLI. The cron schedules that call them live in migrations (D3).
- **D5 — Dashboard on Vercel.** The Vercel project is linked to the GitHub repository; a push to `main` deploys production. The dashboard gets only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (plus `DEMO_ONLY`, below). The service-role key, the database URL and every other secret never go to Vercel.
- **D6 — Verify after every deploy.** Through the MCPs: the Vercel deployment is `READY` with no runtime errors; the cloud migration list equals the repository's; the Edge Functions are `ACTIVE`; the Supabase security advisors show no new finding; and the production UI passes the DevTools check (no console errors, every data request 2xx, figures equal to a database query).
- **D7 — Rollback.** The app rolls back by promoting the previous Vercel deployment. The database never rolls back by hand: a fix is a new forward migration.

## Plan

| Step | Tool | Who |
|---|---|---|
| 1. Tests and typecheck green (`npx jest --runInBand`, `npm run typecheck`) | shell | agent |
| 2. Commit on the task branch; scan the staged diff | git | agent |
| 3. Apply new migrations to the cloud database (`supabase db push --db-url $DATABASE_URL`) | Supabase CLI; checked with Supabase MCP `list_migrations` | agent |
| 4. Deploy changed Edge Functions (`supabase functions deploy <fn> --project-ref <ref> --use-api`) | Supabase CLI; checked with Supabase MCP `list_edge_functions` | agent |
| 5. Merge into `main` and push | git / GitHub | agent, on the owner's request |
| 6. Vercel builds `main` (Git integration) | Vercel MCP `list_deployments`, `get_deployment` | Vercel |
| 7. Verify (D6) | Vercel MCP `get_runtime_errors`; Supabase MCP `get_advisors`; Chrome DevTools MCP | agent; the owner signs in where Google login is needed |

Vercel project: `erp-sync-lab`, framework Next.js, production branch `main`, env vars for Production and Preview: `SUPABASE_URL` (plain) and `SUPABASE_PUBLISHABLE_KEY` (plain: it is public by design and protected by RLS).

Production URL: **https://erp-sync-lab.vercel.app**. Team-scoped aliases and per-deployment URLs stay behind Vercel Authentication (team default), so this is the only public URL and the only one registered in Supabase.

Supabase Auth: the production domain is added to **Authentication → URL Configuration → Redirect URLs** as `https://<domain>/**`. The Site URL stays `http://localhost:3000` until a custom domain exists. There is no MCP or safe CLI command for this (`supabase config push` would overwrite the project's auth settings), so it is an owner action in the dashboard.

Why Git integration and not a CLI deploy: each deployment is tied to a `main` commit and reproducible, and rollback is one click (promote the previous deployment). The publishable key is plain because it is public by design (it reaches every browser in a normal Supabase app); RLS protects the data. The service-role key never leaves `.env` and the Supabase secrets.

## Public demo mode

The public deployment runs with **`DEMO_ONLY=true`**:

- every page redirects to `/demo`, which shows a sanitized snapshot of the figures;
- every `/api/*` and `/auth/*` route returns 404.

With `DEMO_ONLY=false` (the value in `.env.example`, for local development) the full dashboard, the data API and Google sign-in behave as described in the rest of this file.

## Tasks

### R1 — Release spec
- **Done when:** this file is committed with T22.

### R2 — Merge T22 and push
- **Done when:** `feat/t22-auth` is merged into `main` and pushed; full suite green before the merge.

### R3 — Vercel project and first production deploy
- **Done when:** the project exists, linked to the GitHub repository, with the two env vars (D5); a production deployment of `main` is `READY`; anonymous requests get `/login` (pages) and 401 Problem Details (API).

### R4 — Supabase state matches the repository
- **Done when:** Supabase MCP shows every repository migration applied, the five Edge Functions `ACTIVE`, and the security advisors reviewed (new findings fixed or written down below).
- **Result (2026-10-19):** the 22 cloud migrations match the repository, the 5 Edge Functions are `ACTIVE`, the 4 cron jobs are active, RLS is on for the 10 `public` tables and the 7 `internal` tables.

### R5 — Production sign-in and UI check (owner action)
- **Done when:** the production domain is in Supabase's Redirect URLs; the allowlisted account sees the dashboard and a test account sees "Access denied"; the DevTools check (D6) passes on Revenue, Customers, Quarantine and Sync health, with figures equal to a SQL query.

### R5 result — 2026-10-19

Signed in on https://erp-sync-lab.vercel.app with DevTools open (Network tab):

- **Test account (not allowlisted):** Google → `/auth/callback` 303 → `/` 307 → `/denied` 200, still on `erp-sync-lab.vercel.app`. The page names the account and offers only "Sign out"; no `/api/*` request was made, so no data reached the browser (AC10, DA5).
- **Allowlisted account:** Google → `/auth/callback` 303 → `/` 200. Every request 2xx, including `/api/revenue/monthly` and `/api/freshness`, and the Customers, Quarantine and Sync health prefetches.
- **Figures vs the database:** January to June on screen equal `public.monthly_revenue` in the cloud database (Jan $53,395.05 / 30 invoices … Jun $56,110.50 / 29).
- Open point: DevTools showed one console issue badge on both pages; its content was not captured.

### Release log — 2026-10-19 (T25–T29)

- `e92a903` (merge of `perf/t26-load-time`) pushed to `main`. **The Git integration did not create a deployment** for this push (nor for the earlier docs-only `a4704e2`); the production deployment was created through the Vercel MCP (`create_deployment`, git source `main@e92a903`) and reached READY. To investigate: the GitHub ↔ Vercel webhook for the repository (Vercel project → Settings → Git).
- No migration and no Edge Function change in this release (the functions import `problem.ts` and `canonical.ts`, whose changes are backward compatible; the deployed bundles were left as they are).

### Release log — 2026-10-19 (T30, T31)

- `7fd599c` (T30, R20: source-specific reconciliation and valid revenue by source) and `4980d6b` (T31, R21: customers table keeps trends visible; specs R20–R21, AC33–AC41, Q10–Q12) pushed to `main` with `39b8ab0` (architecture diagram updated). The Git integration created the production deployment on its own this time; READY in about 30 s.
- No migration. No Edge Function redeploy: `reconcile-erpnext` imports `reconciliation-service.ts`, whose only change is that `reconciliationPeriod()` moved to `src/core/reconciliation/period.ts` and is re-exported (same period, same behavior); the deployed bundle was left as it is.
- Before the push: 1,225 tests (incl. SQL) and typecheck green; DevTools on localhost against the cloud data (figures equal SQL to the cent; widths 1920–320 px; both themes; no console errors). After the push: anonymous smoke test (`/` → `/login`, `/api/freshness` → 401). The signed-in check in production is an owner action.
- Open: Q12 (very narrow screens, provisional behavior).

## Acceptance

- **DA1** — A push to `main` produces a `READY` production deployment with no build or runtime errors.
- **DA2** — No secret other than the publishable key exists in Vercel; `git grep` finds no key, password or email in the repository.
- **DA3** — Anonymous: every page redirects to `/login`, every `/api/*` returns 401 Problem Details. With `DEMO_ONLY=true`: every page redirects to `/demo`, every `/api/*` and `/auth/*` returns 404.
- **DA4** — The cloud migration list equals `supabase/migrations/`.
- **DA5** — AC10 holds in production (allowlisted account sees data; the test account sees the denied page and no data).

## Known limitations

- No CI: tests run on the developer machine before the merge (step 1), not on GitHub. Adding a GitHub Actions job needs the local Supabase stack in CI and is out of scope.
- Preview deployments use the same Supabase project as production (one free project). They read the same data, behind the same allowlist.
- Supabase security advisor 0029 (authenticated can execute a SECURITY DEFINER function) on `app_queue_metrics` and `app_test_switch` is accepted: both are read-only, have `search_path = ''` and check the allowlist inside, since a definer function bypasses RLS.
- Advisor 0008 (RLS on, no policy) on the `internal.*` tables is the intended deny-all. "Leaked password protection" does not apply: sign-in is Google-only.
- Performance advisors (INFO): no index on `internal.customer_alias.canonical_id`, no primary key on the append-only `public.reconciliation_result`. Negligible at demo volume.
