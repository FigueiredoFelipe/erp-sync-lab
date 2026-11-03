// freshnessService: how fresh each source is and whether the pipeline behind the figures is healthy
// (R10, R13 report, US05; PLAN "Dashboard, API and access"). Tables owned by later tasks (source_file,
// reconciliation_run) and the queue-metrics wrapper may not exist yet: their parts come back as
// `available: false` instead of failing the whole answer.
// Runtime-agnostic: receives a supabase-js client, the test-switch flag and a clock; never reads the environment.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AsOf } from "../core/as-of.ts";
import { syncHealthAlerts, type HealthAlert } from "../core/health/sync-health.ts";
import { toCents } from "../core/money.ts";
import { compareWithReconciliation, monthsOfPeriod, type DatePeriod, type ReconciliationComparison } from "../core/reconciliation/compare.ts";
import { asOfFromSourceDates, readSourceDates } from "./as-of-service.ts";
import { isMissingRelation, type PostgrestErrorLike } from "./postgrest.ts";
import { reconciliationPeriod } from "./reconciliation-service.ts";

export interface ReconciliationRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  erpTotal: string | null;
  storedTotal: string | null;
  unexplained: number | null;
  error: string | null;
}

export interface Freshness {
  checkedAt: string;
  // BR08 as-of date: the earlier of the last ERPNext sync and the newest Source B export.
  asOf: AsOf;
  erpnext: {
    lastSuccessfulSync: string | null;
    lastRun: { status: string; startedAt: string; finishedAt: string | null; error: string | null } | null;
  };
  legacyUnitB: {
    available: boolean;
    newestExportDate: string | null;
    lastSuccessfulIngest: string | null;
  };
  consumer: {
    lastRunAt: string | null;
    processed: number;
    parked: number;
    // As the consumer recorded it on its last run (Postgres interval text).
    oldestMessageAge: string | null;
  };
  queue: {
    available: boolean;
    pending: number | null;
    oldestPendingAgeSeconds: number | null;
    deadLetterQueueLength: number | null;
  };
  // Rows in public.dead_letter: every message ever moved to the DLQ.
  deadLetter: { count: number };
  reconciliation: {
    available: boolean;
    // R20: the period every run covers (the validation period, BR03), from reconciliationPeriod().
    period: DatePeriod;
    latest: ReconciliationRunSummary | null;
    // Q11: the newest succeeded run; the only one the comparison uses (the latest may be running or failed).
    lastSucceeded: ReconciliationRunSummary | null;
    // Current ERPNext (Unit A) valid revenue for `period`, in cents (public.monthly_revenue); null when that
    // read failed (the rest of the answer still loads).
    erpnextValidCents: number | null;
    // AC35: whether that figure may be shown as matching lastSucceeded's stored total, and if not, why;
    // "unavailable" when the figure could not be read.
    comparison: ReconciliationComparison;
  };
  // The red banner: empty when every check passes.
  alerts: HealthAlert[];
}

export interface FreshnessOptions {
  // ENABLE_TEST_SWITCHES=true (local only). When false, internal.test_switch is never read.
  testSwitchesEnabled: boolean;
  now?: () => Date;
}

export const FAIL_FRESHNESS_SWITCH = "fail_freshness_api";

// Thrown on purpose by a test switch (demo scene (b)).
export class InjectedFailureError extends Error {
  constructor(switchName: string) {
    super(`Injected failure: test switch ${switchName} is on`);
    this.name = "InjectedFailureError";
  }
}

// The RPC wrapper not deployed yet: Postgres 42883 or PostgREST PGRST202.
function isMissingFunction(error: PostgrestErrorLike | null): boolean {
  if (!error) return false;
  return error.code === "42883" || error.code === "PGRST202" || /could not find the function/i.test(error.message);
}

// The value of a settled read, or its error thrown.
function fulfilled<T>(settled: PromiseSettledResult<T>): T {
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
}

type SyncRunRow = { status: string; started_at: string; finished_at: string | null; error: string | null };
type HeartbeatRow = { last_run_at: string | null; processed: number | null; parked: number | null; oldest_message_age: string | null };
type MetricRow = { queue_name: string; queue_length: number | string; oldest_msg_age_sec: number | null };
type RevenueRow = { month: string; source: string; revenue: number | string };
type ReconciliationRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  erp_total: number | string | null;
  stored_total: number | string | null;
  unexplained: number | null;
  error: string | null;
};

export function createFreshnessService(client: SupabaseClient, options: FreshnessOptions) {
  const now = options.now ?? (() => new Date());

  async function lastErpRun(): Promise<Freshness["erpnext"]["lastRun"]> {
    const { data, error } = await client
      .from("sync_run")
      .select("status, started_at, finished_at, error")
      .eq("source", "erpnext")
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`sync_run query failed: ${error.message}`);
    const row = ((data ?? []) as SyncRunRow[])[0];
    return row ? { status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error } : null;
  }

  async function heartbeat(): Promise<Freshness["consumer"]> {
    const { data, error } = await client.from("consumer_heartbeat").select("last_run_at, processed, parked, oldest_message_age").limit(1);
    if (error) throw new Error(`consumer_heartbeat query failed: ${error.message}`);
    const row = ((data ?? []) as HeartbeatRow[])[0];
    return {
      lastRunAt: row?.last_run_at ?? null,
      processed: row?.processed ?? 0,
      parked: row?.parked ?? 0,
      oldestMessageAge: row?.oldest_message_age ?? null,
    };
  }

  async function queueMetrics(): Promise<Freshness["queue"]> {
    const { data, error } = await client.rpc("app_queue_metrics");
    if (error) {
      if (isMissingFunction(error)) return { available: false, pending: null, oldestPendingAgeSeconds: null, deadLetterQueueLength: null };
      throw new Error(`app_queue_metrics failed: ${error.message}`);
    }
    const rows = (data ?? []) as MetricRow[];
    const main = rows.find((r) => r.queue_name === "invoice_events");
    const dlq = rows.find((r) => r.queue_name === "invoice_events_dlq");
    return {
      available: true,
      pending: main ? Number(main.queue_length) : null,
      oldestPendingAgeSeconds: main?.oldest_msg_age_sec ?? null,
      deadLetterQueueLength: dlq ? Number(dlq.queue_length) : null,
    };
  }

  async function deadLetterCount(): Promise<number> {
    const { count, error } = await client.from("dead_letter").select("msg_id", { count: "exact", head: true });
    if (error) throw new Error(`dead_letter query failed: ${error.message}`);
    return count ?? 0;
  }

  // The newest reconciliation run (any state), or the newest succeeded one. `available: false` while the
  // table doesn't exist.
  async function reconciliationRun(onlySucceeded: boolean): Promise<{ available: boolean; run: ReconciliationRunSummary | null }> {
    let query = client.from("reconciliation_run").select("id, started_at, finished_at, status, erp_total, stored_total, unexplained, error");
    if (onlySucceeded) query = query.eq("status", "succeeded");
    const { data, error } = await query.order("started_at", { ascending: false }).limit(1);
    if (error) {
      if (isMissingRelation(error)) return { available: false, run: null };
      throw new Error(`reconciliation_run query failed: ${error.message}`);
    }
    const row = ((data ?? []) as ReconciliationRow[])[0];
    return {
      available: true,
      run: row
        ? {
            id: row.id,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            status: row.status,
            erpTotal: row.erp_total === null ? null : String(row.erp_total),
            storedTotal: row.stored_total === null ? null : String(row.stored_total),
            unexplained: row.unexplained,
            error: row.error,
          }
        : null,
    };
  }

  // Current ERPNext valid revenue for the reconciliation's period, in cents: the same view the Revenue page
  // reads (only public.invoice, so quarantined records never count). Only ERPNext rows count: Unit B never
  // enters the comparison (AC35).
  async function erpnextValidCents(months: { from: string; to: string }): Promise<number> {
    const { data, error } = await client
      .from("monthly_revenue")
      .select("month, source, revenue")
      .eq("source", "erpnext")
      .gte("month", `${months.from}-01`)
      .lte("month", `${months.to}-01`);
    if (error) throw new Error(`monthly_revenue query failed: ${error.message}`);
    return ((data ?? []) as RevenueRow[])
      .filter((row) => row.source === "erpnext" && row.month.slice(0, 7) >= months.from && row.month.slice(0, 7) <= months.to)
      .reduce((sum, row) => sum + toCents(row.revenue), 0);
  }

  // ENABLE_TEST_SWITCHES only: whether fail_freshness_api is on.
  async function failureSwitchOn(): Promise<boolean> {
    const { data, error } = await client.rpc("app_test_switch", { p_name: FAIL_FRESHNESS_SWITCH });
    if (error) throw new Error(`app_test_switch failed: ${error.message}`);
    return data === true;
  }

  return {
    async getFreshness(): Promise<Freshness> {
      const checkedAt = now();
      const period = reconciliationPeriod();
      // Before the reads: a period a monthly figure can't cover is a bug, thrown as it is.
      const months = monthsOfPeriod(period);
      // Every read goes out together (R17), the test switch included; all of them are awaited before
      // anything throws, so no read is left rejecting unhandled.
      const [switchRead, datesRead, lastRunRead, consumerRead, queueRead, deadLettersRead, latestRunRead, succeededRunRead, erpnextRead] =
        await Promise.allSettled([
        options.testSwitchesEnabled ? failureSwitchOn() : Promise.resolve(false),
        readSourceDates(client),
        lastErpRun(),
        heartbeat(),
        queueMetrics(),
        deadLetterCount(),
        reconciliationRun(false),
        reconciliationRun(true),
        erpnextValidCents(months),
      ]);
      // The switch decides first: when it is on, the other results don't matter.
      if (fulfilled(switchRead)) throw new InjectedFailureError(FAIL_FRESHNESS_SWITCH);
      const dates = fulfilled(datesRead);
      const lastRun = fulfilled(lastRunRead);
      const consumer = fulfilled(consumerRead);
      const queue = fulfilled(queueRead);
      const deadLetters = fulfilled(deadLettersRead);
      const latestRun = fulfilled(latestRunRead);
      const succeededRun = fulfilled(succeededRunRead);
      // A failed ERPNext revenue read doesn't fail the answer: nothing is compared (fail-closed), and the
      // page says the figure could not be loaded.
      if (erpnextRead.status === "rejected") console.error("freshness: ERPNext valid revenue read failed", erpnextRead.reason);
      const erpnextCents = erpnextRead.status === "fulfilled" ? erpnextRead.value : null;
      const lastSucceeded = latestRun.available ? succeededRun.run : null;
      // The two run reads race a run finishing in between: a succeeded run at least as new as the "latest"
      // one is the latest.
      const latest =
        lastSucceeded && (latestRun.run === null || Date.parse(lastSucceeded.startedAt) >= Date.parse(latestRun.run.startedAt))
          ? lastSucceeded
          : latestRun.run;
      const reconciliation: Freshness["reconciliation"] = {
        available: latestRun.available,
        period,
        latest,
        lastSucceeded,
        erpnextValidCents: erpnextCents,
        // Every run covers reconciliationPeriod() (no caller passes another), so the run's period is that one.
        comparison:
          erpnextCents === null
            ? { result: "unavailable" }
            : compareWithReconciliation({
                breakdownPeriod: period,
                erpnextValidCents: erpnextCents,
                run: lastSucceeded ? { period, startedAt: lastSucceeded.startedAt, storedTotal: lastSucceeded.storedTotal } : null,
              }),
      };

      const alerts = syncHealthAlerts(
        {
          consumerLastRunAt: consumer.lastRunAt,
          parked: consumer.parked,
          oldestPendingAgeSeconds: queue.oldestPendingAgeSeconds,
          // "DLQ not empty": the messages sitting in the DLQ queue; without the metrics wrapper, the
          // dead_letter ledger (fail-closed: it can only over-report).
          deadLetters: queue.deadLetterQueueLength ?? deadLetters,
          reconciliationUnexplained: reconciliation.latest?.unexplained ?? null,
        },
        checkedAt,
      );

      return {
        checkedAt: checkedAt.toISOString(),
        asOf: asOfFromSourceDates(dates, checkedAt),
        erpnext: { lastSuccessfulSync: dates.erpnextLastSuccessfulSync, lastRun },
        legacyUnitB: {
          available: dates.sourceBAvailable,
          newestExportDate: dates.sourceBNewestExport,
          lastSuccessfulIngest: dates.sourceBLastSuccessfulIngest,
        },
        consumer,
        queue,
        deadLetter: { count: deadLetters },
        reconciliation,
        alerts,
      };
    },
  };
}

export type FreshnessService = ReturnType<typeof createFreshnessService>;
