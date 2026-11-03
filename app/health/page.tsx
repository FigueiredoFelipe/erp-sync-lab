"use client";

// Sync health (R10, R13 report, US05): freshness per source and the state of the pipeline behind the
// figures. The red banner follows PLAN "Dashboard, API and access": consumer heartbeat older than 5 min,
// oldest pending message older than 10 min, DLQ not empty (or parked messages), unexplained
// reconciliation differences. Stable data-testids: health-banner, health-alert-<CODE>, and one per figure.
// R20 (T30): the reconciliation is labeled as what it is, a check of ERPNext (Unit A) only, and a separate
// region shows valid revenue by source for the reconciliation's period (breakdown-erpnext,
// breakdown-legacy_unit_b, breakdown-total, breakdown-period, reconciliation-comparison). The breakdown's
// request goes out in parallel with freshness: the period is imported, not read from freshness.
import { useEffect, useState, type ReactNode } from "react";
import { SOURCE_IDS, type SourceId } from "../../src/core/canonical.ts";
import { formatUsdCents, toCents } from "../../src/core/money.ts";
import {
  monthsOfPeriod,
  periodCoverage,
  reconcileBreakdownWithComparison,
  type BreakdownComparison,
  type DatePeriod,
  type LoadedBreakdown,
  type PeriodCoverage,
} from "../../src/core/reconciliation/compare.ts";
import { formatTimestamp } from "../../src/core/timestamp.ts";
import type { Freshness, ReconciliationRunSummary } from "../../src/services/freshness-service.ts";
import { reconciliationPeriod } from "../../src/core/reconciliation/period.ts";
import type { MonthlyRevenue, SourceRevenue } from "../../src/services/revenue-service.ts";
import { DataRegion } from "../_components/data-region.tsx";
import { dateLabel, fetchJson, monthLabel, type Load } from "../_components/fetch-json.ts";
import { pageReady, regionReady } from "../_components/load-state.ts";
import { SkeletonCards } from "../_components/skeleton.tsx";
import { SOURCE_LABELS } from "../_components/sources.ts";

const NOT_AVAILABLE = "not available yet";
// The breakdown covers the reconciliation's period (Q10), the same function the run uses as its default.
const BREAKDOWN_PERIOD: DatePeriod = reconciliationPeriod();
const BREAKDOWN_MONTHS = monthsOfPeriod(BREAKDOWN_PERIOD);
const BREAKDOWN_URL = `/api/revenue/monthly?from=${BREAKDOWN_MONTHS.from}&to=${BREAKDOWN_MONTHS.to}`;

function ts(value: string | null): string {
  return value ? formatTimestamp(value) : "never";
}

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

// Words, never a dash, in a figure slot (R20).
function money(value: string | null): string {
  return value === null ? "not available" : formatUsdCents(toCents(value));
}

// "Jan 2026 – Dec 2026"
function monthsText(period: DatePeriod): string {
  const months = monthsOfPeriod(period);
  return `${monthLabel(months.from)} – ${monthLabel(months.to)}`;
}

// PLAN "Period label": "Jan 2026 – Dec 2026, data through Oct 18, 2026 (Oct 2026 partial)".
function periodText(coverage: PeriodCoverage): string {
  const range = `${monthLabel(coverage.firstMonth)} – ${monthLabel(coverage.lastMonth)}`;
  if (!coverage.dataThrough || !coverage.partialMonth) return range;
  return `${range}, data through ${dateLabel(coverage.dataThrough)} (${monthLabel(coverage.partialMonth)} partial)`;
}

export default function HealthPage() {
  const [freshness, setFreshness] = useState<Load<Freshness>>({ state: "loading" });
  const [breakdown, setBreakdown] = useState<Load<MonthlyRevenue>>({ state: "loading" });
  // Bumped by "Try again": re-runs the load.
  const [attempt, setAttempt] = useState(0);
  const [breakdownAttempt, setBreakdownAttempt] = useState(0);

  useEffect(() => {
    let stale = false;
    fetchJson<Freshness>("/api/freshness")
      .then((data) => {
        if (!stale) setFreshness({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (stale) return;
        console.error("Failed to load freshness", error);
        setFreshness({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      stale = true;
    };
  }, [attempt]);

  // Its own load, issued together with freshness on the first render.
  useEffect(() => {
    let stale = false;
    fetchJson<MonthlyRevenue>(BREAKDOWN_URL)
      .then((data) => {
        if (!stale) setBreakdown({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (stale) return;
        console.error("Failed to load valid revenue by source", error);
        setBreakdown({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      stale = true;
    };
  }, [breakdownAttempt]);

  // R18: the region goes to loading in the click handler, then the load runs again.
  function retry() {
    setFreshness({ state: "loading" });
    setAttempt((n) => n + 1);
  }

  function retryBreakdown() {
    setBreakdown({ state: "loading" });
    setBreakdownAttempt((n) => n + 1);
  }

  return (
    <main className="wide" data-page="health" data-ready={pageReady(regionReady(freshness), regionReady(breakdown))}>
      <h1>Sync health</h1>
      <p className="as-of">How fresh each source is, and whether anything is stuck between the sources and the figures.</p>
      {/* Fail-closed: if health can't be read, the red banner says so (with "Try again") rather than showing nothing. */}
      <DataRegion
        what="sync health"
        load={freshness}
        onRetry={retry}
        testId="region-health"
        errorVariant="banner"
        errorNote="Treat the figures as unverified."
        placeholder={
          <>
            {/* One banner line (the all-clear banner's height), so the headings below don't jump when it renders. */}
            <div className="banner banner-ok" aria-hidden="true">
              <span className="skeleton skeleton-inline" />
            </div>
            <h2>Sources</h2>
            <SkeletonCards count={3} />
            <h2>Pipeline</h2>
            <SkeletonCards count={3} />
            <h2>Reconciliation</h2>
            <SkeletonCards count={1} />
          </>
        }
      >
        {(data) => <HealthView data={data} />}
      </DataRegion>

      <h2>Valid revenue by source</h2>
      <DataRegion
        what="valid revenue by source"
        load={breakdown}
        onRetry={retryBreakdown}
        testId="region-breakdown"
        errorNote="No figure is shown in its place."
        placeholder={
          <>
            <p className="as-of" aria-hidden="true">
              <span className="skeleton skeleton-inline" />
            </p>
            <SkeletonCards count={3} />
          </>
        }
      >
        {(data) => <BreakdownView data={data} freshness={freshness} />}
      </DataRegion>
    </main>
  );
}

function Stat({ label, value, testId, bad, children }: { label: string; value: ReactNode; testId: string; bad?: boolean; children?: ReactNode }) {
  return (
    <section className="card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value${bad ? " bad" : ""}`} data-testid={testId}>
        {value}
      </p>
      {children}
    </section>
  );
}

function HealthView({ data }: { data: Freshness }) {
  const codes = new Set(data.alerts.map((a) => a.code));
  const reconciliation = data.reconciliation.latest;

  return (
    <>
      {data.alerts.length > 0 ? (
        <div className="banner banner-critical" role="alert" data-testid="health-banner" data-state="critical">
          <strong>
            {data.alerts.length} problem{data.alerts.length === 1 ? "" : "s"}: the figures may be stale or incomplete.
          </strong>
          <ul>
            {data.alerts.map((alert) => (
              <li key={alert.code} data-testid={`health-alert-${alert.code}`}>
                {alert.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="banner banner-ok" data-testid="health-banner" data-state="ok">
          All checks pass. Checked {formatTimestamp(data.checkedAt)}.
        </div>
      )}

      <h2>Sources</h2>
      <div className="stats">
        <Stat label="ERPNext (Unit A): last successful sync" value={ts(data.erpnext.lastSuccessfulSync)} testId="health-erpnext-last-sync">
          {data.erpnext.lastRun && (
            <dl className="kv">
              <dt>Last run</dt>
              <dd data-testid="health-erpnext-last-run">
                {data.erpnext.lastRun.status}, {ts(data.erpnext.lastRun.finishedAt ?? data.erpnext.lastRun.startedAt)}
              </dd>
              {data.erpnext.lastRun.error && (
                <>
                  <dt>Error</dt>
                  <dd>{data.erpnext.lastRun.error}</dd>
                </>
              )}
            </dl>
          )}
        </Stat>
        <Stat
          label="Unit B export: newest export date"
          value={
            !data.legacyUnitB.available ? <span className="muted">{NOT_AVAILABLE}</span> : data.legacyUnitB.newestExportDate ? dateLabel(data.legacyUnitB.newestExportDate) : "none ingested"
          }
          testId="health-unitb-export-date"
        >
          {data.legacyUnitB.available && (
            <dl className="kv">
              <dt>Last successful ingest</dt>
              <dd data-testid="health-unitb-last-ingest">{ts(data.legacyUnitB.lastSuccessfulIngest)}</dd>
            </dl>
          )}
        </Stat>
        <Stat label="As-of date of the figures" value={dateLabel(data.asOf.date)} testId="health-as-of">
          <p className="partial-note">
            {data.asOf.basis === "both" && "The earlier of the last ERPNext sync and the newest Unit B export."}
            {data.asOf.basis === "erpnext" && "The last ERPNext sync (no Unit B export yet)."}
            {data.asOf.basis === "legacy_unit_b" && "The newest Unit B export (no ERPNext sync yet)."}
            {data.asOf.basis === "today" && "Today: no source has synced yet."}
          </p>
        </Stat>
      </div>

      <h2>Pipeline</h2>
      <div className="stats">
        <Stat
          label="Queue consumer: last run"
          value={ts(data.consumer.lastRunAt)}
          testId="health-consumer-last-run"
          bad={codes.has("CONSUMER_STALE") || codes.has("CONSUMER_NEVER_RAN")}
        >
          <dl className="kv">
            <dt>Processed in last run</dt>
            <dd data-testid="health-consumer-processed">{data.consumer.processed}</dd>
            <dt>Moved to the DLQ in last run</dt>
            <dd data-testid="health-consumer-parked">{data.consumer.parked}</dd>
          </dl>
        </Stat>
        <Stat
          label="Oldest pending message"
          value={data.queue.available ? age(data.queue.oldestPendingAgeSeconds) : <span className="muted">{NOT_AVAILABLE}</span>}
          testId="health-oldest-pending"
          bad={codes.has("QUEUE_BACKLOG")}
        >
          {data.queue.available && (
            <dl className="kv">
              <dt>Pending messages</dt>
              <dd data-testid="health-pending">{data.queue.pending ?? "—"}</dd>
            </dl>
          )}
        </Stat>
        <Stat
          label="Dead-letter queue"
          value={data.queue.deadLetterQueueLength ?? data.deadLetter.count}
          testId="health-dlq-count"
          bad={codes.has("DEAD_LETTERS")}
        >
          <dl className="kv">
            <dt>Moved to the DLQ, ever</dt>
            <dd data-testid="health-dead-letter-total">{data.deadLetter.count}</dd>
          </dl>
        </Stat>
      </div>

      <h2>Reconciliation</h2>
      <div className="stats">
        <Stat
          label="ERPNext reconciliation — Unit A only"
          value={reconciliationValue(data.reconciliation.available, reconciliation)}
          testId="health-reconciliation"
          bad={codes.has("RECONCILIATION_UNEXPLAINED") || reconciliation?.status === "failed"}
        >
          <p className="partial-note" data-testid="health-reconciliation-scope">
            Compares the ERPNext (Unit A) source documents with the ERPNext records we stored. Unit B is not included.
          </p>
          <dl className="kv">
            <dt>Period</dt>
            <dd data-testid="health-reconciliation-period">
              {monthsText(data.reconciliation.period)}
              {data.reconciliation.lastSucceeded && `, ERPNext as of the run start ${ts(data.reconciliation.lastSucceeded.startedAt)}`}
            </dd>
          </dl>
          {reconciliation && <LatestRun run={reconciliation} />}
          {data.reconciliation.available && reconciliation && reconciliation.id !== data.reconciliation.lastSucceeded?.id && (
            <div className="recon-previous" data-testid="health-reconciliation-previous">
              <p className="stat-label">Previous successful run</p>
              {data.reconciliation.lastSucceeded ? (
                <RunTotals run={data.reconciliation.lastSucceeded} testIdPrefix="health-reconciliation-previous" />
              ) : (
                <p className="stat-value" data-testid="health-reconciliation-previous-none">
                  No reconciliation yet
                </p>
              )}
            </div>
          )}
        </Stat>
      </div>
    </>
  );
}

// The headline of the reconciliation card: the latest run's state, never a total.
function reconciliationValue(available: boolean, latest: ReconciliationRunSummary | null): ReactNode {
  if (!available) return <span className="muted">{NOT_AVAILABLE}</span>;
  if (!latest) return "No reconciliation yet";
  if (latest.status === "running") return `running since ${ts(latest.startedAt)}`;
  if (latest.status === "failed") return "failed";
  if (latest.status === "succeeded") {
    return latest.unexplained === null ? "succeeded, unexplained count not available" : `succeeded, ${latest.unexplained} unexplained`;
  }
  return latest.status;
}

// The latest run: its totals only when it succeeded (AC37); running or failed shows its state instead.
function LatestRun({ run }: { run: ReconciliationRunSummary }) {
  if (run.status === "succeeded") return <RunTotals run={run} testIdPrefix="health-reconciliation" />;
  return (
    <dl className="kv">
      {run.status === "running" ? (
        <>
          <dt>Started</dt>
          <dd data-testid="health-reconciliation-run">{ts(run.startedAt)}</dd>
          <dt>Totals</dt>
          <dd>not computed yet: run in progress</dd>
        </>
      ) : (
        <>
          <dt>Run</dt>
          <dd data-testid="health-reconciliation-run">{ts(run.finishedAt ?? run.startedAt)}</dd>
          <dt>Totals</dt>
          <dd>not computed: run failed</dd>
          <dt>Error</dt>
          <dd data-testid="health-reconciliation-error">{run.error ?? "not recorded"}</dd>
        </>
      )}
    </dl>
  );
}

// A succeeded run: when it ran, its two totals and the unexplained count (AC33).
function RunTotals({ run, testIdPrefix }: { run: ReconciliationRunSummary; testIdPrefix: string }) {
  return (
    <dl className="kv">
      <dt>Run</dt>
      <dd data-testid={`${testIdPrefix}-run`}>{ts(run.finishedAt ?? run.startedAt)}</dd>
      <dt>ERPNext total</dt>
      <dd data-testid={`${testIdPrefix}-erp-total`}>{money(run.erpTotal)}</dd>
      <dd className="kv-note">Includes ERPNext documents not in the figures: in transit, in quarantine or dead-lettered.</dd>
      <dt>Stored total</dt>
      <dd data-testid={`${testIdPrefix}-stored-total`}>{money(run.storedTotal)}</dd>
      <dt>Unexplained</dt>
      <dd data-testid={`${testIdPrefix}-unexplained`}>{run.unexplained ?? "not available"}</dd>
      {run.error && (
        <>
          <dt>Error</dt>
          <dd>{run.error}</dd>
        </>
      )}
    </dl>
  );
}

// "$1,234.56", or "$0.00 · no invoices in period" for a part with no invoices (AC37: labeled, not a failure).
function partValue(part: SourceRevenue): ReactNode {
  if (part.invoices > 0) return formatUsdCents(part.revenueCents);
  return (
    <>
      {formatUsdCents(part.revenueCents)} <span className="muted">· no invoices in period</span>
    </>
  );
}

// R20, AC34–AC37: valid revenue by source for the reconciliation's period, and whether its ERPNext figure
// may be read against the reconciliation (decided by the freshness service, compareWithReconciliation).
function BreakdownView({ data, freshness }: { data: MonthlyRevenue; freshness: Load<Freshness> }) {
  const coverage = periodCoverage({ from: data.from, to: data.to }, data.asOf.date);
  const parts = data.total.bySource;

  return (
    <>
      <p className="as-of" data-testid="breakdown-period">
        Period: {periodText(coverage)}
      </p>
      <div className="stats">
        {SOURCE_IDS.map((source: SourceId) => (
          <Stat key={source} label={SOURCE_LABELS[source]} value={partValue(parts[source])} testId={`breakdown-${source}`}>
            {source === "legacy_unit_b" && <UnitBExportNote freshness={freshness} />}
          </Stat>
        ))}
        {/* Both parts come in the same response: the sum is shown only because both loaded (AC37). */}
        <Stat label="Total (Units A + B)" value={formatUsdCents(data.total.revenueCents)} testId="breakdown-total" />
      </div>
      <p className="partial-note">
        Valid revenue: invoices stored after validation, credit notes negative. Records in quarantine are not included.
      </p>
      <ComparisonLine freshness={freshness} breakdown={{ from: data.from, to: data.to, erpnextCents: parts.erpnext.revenueCents }} />
    </>
  );
}

// The export date of the file the Unit B figure comes from (AC34, R10); nothing while freshness loads.
function UnitBExportNote({ freshness }: { freshness: Load<Freshness> }) {
  if (freshness.state === "loading") return null;
  let text: string;
  if (freshness.state === "error") text = "Export date not available: sync health could not be loaded.";
  else {
    const unitB = freshness.data.legacyUnitB;
    text = !unitB.available
      ? "Export date not available yet."
      : unitB.newestExportDate
        ? `Latest export: ${dateLabel(unitB.newestExportDate)} (each export is a full snapshot, BR10).`
        : "No export ingested yet.";
  }
  return (
    <p className="partial-note" data-testid="breakdown-legacy_unit_b-export">
      {text}
    </p>
  );
}

function ComparisonLine({ freshness, breakdown }: { freshness: Load<Freshness>; breakdown: LoadedBreakdown }) {
  // No test id while loading (R18); the freshness region shows its own error.
  if (freshness.state === "loading") return null;
  if (freshness.state === "error") {
    return (
      <p className="partial-note" data-testid="reconciliation-comparison-unavailable">
        Not compared with the reconciliation: sync health could not be loaded.
      </p>
    );
  }
  // The rule lives in compare.ts (unit-tested); the page only renders its result.
  const comparison = reconcileBreakdownWithComparison(breakdown, freshness.data.reconciliation);
  return (
    <p className="recon-comparison" data-testid="reconciliation-comparison" data-result={comparison.result}>
      {comparisonText(comparison)}
    </p>
  );
}

function comparisonText(comparison: BreakdownComparison): string {
  switch (comparison.result) {
    case "matches":
      return `ERPNext (Unit A) valid revenue ${formatUsdCents(comparison.erpnextValidCents)} matches the stored total of the reconciliation run started ${ts(comparison.runStartedAt)}, for the same period.`;
    case "changed-since-run":
      return `Not compared with the reconciliation: ERPNext data changed since the run started at ${ts(comparison.runStartedAt)}. ERPNext (Unit A) valid revenue now ${formatUsdCents(comparison.erpnextValidCents)}; stored total at the run ${comparison.storedTotalCents === null ? "not recorded" : formatUsdCents(comparison.storedTotalCents)}.`;
    case "changed-while-loading":
      return `Not compared with the reconciliation: the ERPNext figure changed while this page loaded (${formatUsdCents(comparison.erpnextValidCents)} when it was compared). Try again to compare.`;
    case "different-period":
      return `Not compared with the reconciliation: it covers ${monthsText(comparison.runPeriod)}, this breakdown covers ${monthsText(comparison.breakdownPeriod)}.`;
    case "no-successful-run":
      return "Not compared with the reconciliation: no run has succeeded yet.";
    case "unavailable":
      return "Not compared with the reconciliation: the ERPNext figure could not be loaded.";
  }
}
