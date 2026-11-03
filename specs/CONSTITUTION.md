# Constitution

Principles to be followed by every decision on the project. If a task goes against any rule in this constitution, stop and discuss.

## Core principles

These principles take precedence over any technical detail in the sections below.

1. **Fail-closed.** When in doubt, don't publish: a record that fails validation goes to quarantine, never to the report.
   Rationale: A wrong number on a board deck is worse than a missing one, and a wrong financial dashboard costs trust in the whole system; an invoice with a mismatched total or an unmatched customer goes to quarantine for a human to review instead.
2. **Idempotency.** Processing the same invoice twice gives the same result as processing it once.
   Rationale: Queues deliver at least once and the same invoice can arrive by webhook and by polling, so duplicates will happen; true exactly-once delivery is costly and fragile, while upserts (`INSERT ... ON CONFLICT DO UPDATE`) keyed on source system plus source ID are cheap and robust.
3. **Deterministic first.** Rules and calculations are code. An LLM is used only for subjective tasks and never has the final word on a number.
   Rationale: Sums, totals and validations are deterministic code; an LLM only handles judgment calls (e.g. classifying an expense category), with a confidence floor and human review below it.
4. **The ERP belongs to the client.** Reading is free; writing only as a draft (docstatus 0), with human approval.
   Rationale: The ERP is the client's system of record, so even when write-back is allowed the system starts read-only and writes only drafts (ERPNext docstatus 0; 1 = submitted) behind an approval step.
5. **No secrets in the repository.** Keys live only in `.env` locally and in the platform's secret store in production (Vercel env vars, Supabase secrets).
   Rationale: `.env` is in `.gitignore`; on AWS the equivalent store would be Secrets Manager.
6. **Adversarial review instead of a human gate.** The agent implements everything, including `IncrementalSync`. Instead of a human review gate, every critical piece (IncrementalSync, the consumer with the idempotent upsert, validation/quarantine) is reviewed by two adversarial reviewer agents before it is merged; findings are fixed or written down as known limitations.
   Rationale: Nothing critical merges on one agent's word: one reviewer hunts correctness bugs and the other checks that the tests actually prove the spec. Only what the owner alone can do (sign-in, passwords, scope decisions) sits on the critical path.

## Stack

- TypeScript everywhere. Next.js (React) for the dashboard and its API routes, deployed on Vercel.
  Rationale: Next.js keeps the UI and the HTTP routes in one project with a direct Vercel deploy; API routes run as short-lived serverless functions.
- PostgreSQL (Supabase), Supabase Queues (pgmq), Supabase Edge Functions, `pg_cron`.
  Rationale: Postgres holds the canonical model, the watermark and the quarantine; Supabase Queues follows the SQS model, Edge Functions are the Lambda equivalent and `pg_cron` the EventBridge Scheduler equivalent.
- Queue consumers ("workers") are Supabase Edge Functions triggered by `pg_cron`, draining the queue in batches. Nothing runs on a developer machine.
  Rationale: Each job is short (validate and store one invoice), so a scheduled function that reads a batch with a visibility timeout, upserts and deletes the messages is enough, like SQS triggering Lambda; long jobs such as OCR on large PDFs would move to long-running workers (e.g. ECS Fargate scaled on queue depth), since the choice depends on job size.
- Tests with Jest.

## Runtime limits (Supabase free plan)

The rules below keep the system comfortably within the free plan's limits, designed for up front rather than discovered in production. If the plan changes, revisit this section.

- A consumer run processes at most 10 messages and must finish well within the 150-second wall-clock limit.
  Rationale: A function that exceeds the wall-clock limit is killed mid-batch; a batch of 10 messages finishes in seconds.
- The queue's visibility timeout is longer than the longest expected batch.
  Rationale: If the timeout is shorter than processing time, a message reappears while still in flight and runs twice; idempotency absorbs it, but it is wasted work.
- No CPU-heavy work inside Edge Functions. Work there is I/O (ERP calls, SQL); anything CPU-heavy moves to a long-running worker.
  Rationale: The CPU limit is low (the limits page says 2 s per run; a troubleshooting page says 200 ms), but network wait does not count, so ERP calls and database writes fit while heavy parsing, OCR or image processing would not.
- Invocations stay far below the monthly quota.
  Rationale: Consumer every minute (~43k/month) + ERPNext polling every 5 minutes (~8.6k/month) + CSV check every 5 minutes (~8.6k/month) + daily reconciliation (30/month) + a few webhooks ≈ 61k/month, against a free-plan quota of 500k/month.
- Cron schedules are defined in SQL migrations in the repository, never only in the dashboard.
  Rationale: A free project pauses after 7 days idle and `pg_cron` jobs reportedly don't resume on unpause; schedules in migrations can simply be reapplied and stay versioned and reviewable.

## Architecture

- HTTP handlers never access the database directly; they call a service.
  Rationale: A handler only receives the request (e.g. `GET /api/customers/spend`), validates its shape and calls a service.
- Business rules don't live in HTTP handlers or in Edge Functions; they live in services.
  Rationale: A rule such as "the total must equal the sum of the lines" lives in one testable place instead of being spread across routes and functions.
- All ERP access goes through an ERP adapter. No other module calls the ERP API directly.
  Rationale: Each ERP gets an adapter that implements the same interface and returns the same canonical model (one for ERPNext, one for the on-premise CSV); seven ERPs means seven adapters, and the rest of the pipeline doesn't change.
- For API sources, data enters through two paths: ERP webhooks for speed, and periodic polling of the ERP's REST API with a watermark as the backstop for consistency. Webhooks are never the only path.
  Rationale: Webhooks give latency but can be lost (the ERP fails to send, the function is down); watermark polling catches what they miss, and idempotent upserts let both paths overlap safely.
- File sources (legacy exports without an API) enter through a storage bucket read by a scheduled job.
  Rationale: The legacy CSV source has no API or webhook, so the two-path rule above does not apply to it.
- The watermark is the pair (`modified`, `name`) and advances only after the batch is committed.
  Rationale: Several invoices can share the same `modified` timestamp and pagination would skip some, so `name` breaks ties; advancing only after commit means a crash causes a replay, never a gap.
- The webhook handler only validates and enqueues; it never processes.
  Rationale: The handler must answer the ERP quickly, otherwise the ERP may resend or give up; heavy work belongs to the consumers.
- No new dependency enters without an explicit justification written in the plan.

## Errors

- HTTP errors use the correct status code with a Problem Details body (RFC 9457, `application/problem+json`): 400 malformed request, 401/403 not authorized, 404 not found, 405 method not allowed, 422 validation failed, 500 unexpected error, 502 ERP unavailable.
  Rationale: 400 means the caller sent something wrong, not every failure (ERP down is 502, an internal bug is 500); the body keeps the same shape (type, title, status, detail) so callers always handle errors the same way.
- Consumer errors: transient failures (timeout, ERP 5xx, 429 rate limit) are retried with backoff; validation failures go to quarantine; after N attempts, the message goes to the dead-letter queue.
  Rationale: Most errors here happen in consumers, not over HTTP; bad data goes to quarantine because retrying won't fix it, and anything that keeps failing lands in a dead-letter queue for investigation.

## Quality

- Every business rule must have a unit test.
- Every endpoint must have at least one integration test for the happy path and one for a failure path.
  Rationale: In a fail-closed system, the failure path matters as much as the happy path.
- Every UI change is verified by the agent through the Chrome DevTools MCP before it is reported as done: no console errors, every data request returns 2xx, and the values on screen match a database query.
  Rationale: A unit test proves the rule, not that the screen shows the right number; the agent catches console errors, failing requests behind a spinner and figures that differ from the database, while a human judges what it can't, such as a chart that is technically right but misleading.

## Conventions

- Names, classes, variables, comments and all generated code must be in English.
- Commits follow Conventional Commits: `type(scope): description`, plus the Linear issue ID when one exists. Example: `feat(sync): add watermark cursor [ERP-12]`.
  Rationale: `type` is one of feat, fix, test, docs, refactor, chore; `scope` is the part of the system; the issue ID is optional.

## Governance

- If the plan contradicts the constitution, the plan changes.
- If the constitution needs an update, the update goes in a separate commit.
