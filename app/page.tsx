"use client";

// Revenue by month. Data is fetched client-side from the API routes, so every call shows in DevTools.
// Figures carry stable data-testids (revenue-YYYY-MM, invoices-YYYY-MM, revenue-total, data-as-of,
// partial-YYYY-MM, partial-note, bar-YYYY-MM-<source> with data-cents and data-partial) for agent-driven
// verification (PLAN "Agent-driven UI verification").
// T10c: the month that isn't complete at the as-of date is marked partial (hatched segments, "partial, through
// <date>"). `?partial=off` turns the marking off, to compare the two views.
// R19 (T29): each month's bar is stacked by source (stackOffset="sign": a negative source goes below zero).
// R20 (T30): three compact figures above the chart (summary-total, summary-erpnext, summary-legacy_unit_b,
// summary-period) for the page's own period, from total.bySource.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type BarShapeProps } from "recharts";
import { SOURCE_IDS, type SourceId } from "../src/core/canonical.ts";
import { formatUsdCents } from "../src/core/money.ts";
import { monthsOfPeriod, periodCoverage } from "../src/core/reconciliation/compare.ts";
import { formatTimestamp } from "../src/core/timestamp.ts";
import type { MonthlyRevenue, SourceRevenue } from "../src/services/revenue-service.ts";
import type { Freshness } from "../src/services/freshness-service.ts";
import { reconciliationPeriod } from "../src/core/reconciliation/period.ts";
import { dateLabel, fetchJson, monthLabel, type Load } from "./_components/fetch-json.ts";
import { DataRegion, InlineRetry } from "./_components/data-region.tsx";
import { pageReady, regionReady } from "./_components/load-state.ts";
import { SkeletonChart, SkeletonTable } from "./_components/skeleton.tsx";
import { SOURCE_LABELS } from "./_components/sources.ts";
import { segmentGeometry } from "./_components/stack-geometry.ts";

const MONTHLY_URL = "/api/revenue/monthly?from=2026-01&to=2026-10";

// What the figures region renders: the monthly figures and, above them, the sync-health alerts (if
// freshness loaded). null freshness = freshness failed, so no banner (PLAN "Loading feedback (R18)" 5).
type Figures = { revenue: MonthlyRevenue; freshness: Freshness | null };

export default function RevenuePage() {
  const [revenue, setRevenue] = useState<Load<MonthlyRevenue>>({ state: "loading" });
  const [freshness, setFreshness] = useState<Load<Freshness>>({ state: "loading" });
  // The figures wait for the first freshness result only, so banner and figures appear together; a later
  // "Try again" of the "data as of" line leaves the figures on screen (AC27).
  const [freshnessSettledOnce, setFreshnessSettledOnce] = useState(false);
  const [showPartial, setShowPartial] = useState(true);
  // Stale-response guards: only the latest request of each kind may set its state.
  const revenueRequest = useRef(0);
  const freshnessRequest = useRef(0);
  const asOfLine = useRef<HTMLSpanElement>(null);
  // Polite status for the "data as of" line, outside its busy span, like DataRegion's: '' -> "Loading data
  // as of…" -> "Data as of loaded"; cleared on failure, where the InlineRetry alert is the only announcement.
  const [asOfStatus, setAsOfStatus] = useState("");

  useEffect(() => {
    if (freshness.state === "loading") setAsOfStatus("Loading data as of…");
    else if (freshness.state === "ok") setAsOfStatus("Data as of loaded");
    else setAsOfStatus("");
  }, [freshness.state]);

  const loadRevenue = useCallback(() => {
    const id = ++revenueRequest.current;
    setRevenue({ state: "loading" });
    fetchJson<MonthlyRevenue>(MONTHLY_URL)
      .then((data) => {
        if (id === revenueRequest.current) setRevenue({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (id !== revenueRequest.current) return;
        console.error("Failed to load monthly revenue", error);
        setRevenue({ state: "error", message: String(error) });
      });
  }, []);

  const loadFreshness = useCallback(() => {
    const id = ++freshnessRequest.current;
    setFreshness({ state: "loading" });
    fetchJson<Freshness>("/api/freshness")
      .then((data) => {
        if (id !== freshnessRequest.current) return;
        setFreshness({ state: "ok", data });
        setFreshnessSettledOnce(true);
      })
      .catch((error: unknown) => {
        if (id !== freshnessRequest.current) return;
        console.error("Failed to load freshness", error);
        setFreshness({ state: "error", message: String(error) });
        setFreshnessSettledOnce(true);
      });
  }, []);

  useEffect(() => {
    setShowPartial(new URLSearchParams(window.location.search).get("partial") !== "off");
    loadRevenue();
    loadFreshness();
  }, [loadRevenue, loadFreshness]);

  function retryAsOf() {
    // The button disappears once the line is loading again: keep focus on the line.
    asOfLine.current?.focus();
    loadFreshness();
  }

  const figures: Load<Figures> =
    revenue.state !== "ok"
      ? revenue
      : freshness.state === "loading" && !freshnessSettledOnce
        ? { state: "loading" }
        : { state: "ok", data: { revenue: revenue.data, freshness: freshness.state === "ok" ? freshness.data : null } };

  return (
    <main data-page="revenue" data-ready={pageReady(regionReady(figures), regionReady(freshness))}>
      <h1>Revenue by month — Harvest Table Foods</h1>
      <p className="as-of">
        Data as of{" "}
        <span
          ref={asOfLine}
          className="data-region"
          data-ready={regionReady(freshness)}
          aria-busy={freshness.state === "loading" ? true : undefined}
          tabIndex={-1}
        >
          {freshness.state === "loading" && <span className="skeleton skeleton-inline" aria-hidden="true" />}
          {freshness.state === "ok" && (
            // "—" only for a source that has never synced (null lastSuccessfulSync).
            <span data-testid="data-as-of">
              {freshness.data.erpnext.lastSuccessfulSync ? formatTimestamp(freshness.data.erpnext.lastSuccessfulSync) : "—"}
            </span>
          )}
          {freshness.state === "error" && <InlineRetry what="data as of" testId="as-of" onRetry={retryAsOf} />}
        </span>
        <span role="status" className="visually-hidden">
          {asOfStatus}
        </span>
      </p>

      <DataRegion
        what="monthly revenue"
        load={figures}
        onRetry={loadRevenue}
        testId="region-revenue"
        // Fail-closed: when the figures fail but freshness loaded with alerts, the alerts stay on screen next to
        // the error (PLAN "Loading feedback (R18)" 5).
        errorLead={freshness.state === "ok" ? <HealthBanner health={freshness.data} /> : null}
        placeholder={
          <>
            <SkeletonSummary />
            <SkeletonChart />
            <SkeletonTable rows={10} columns={3} />
          </>
        }
      >
        {({ revenue: data, freshness: health }) => (
          <>
            {health && <HealthBanner health={health} />}
            <RevenueView data={data} showPartial={showPartial} />
          </>
        )}
      </DataRegion>
    </main>
  );
}

// The sync-health alerts above the figures; nothing when there are none.
function HealthBanner({ health }: { health: Freshness }) {
  if (health.alerts.length === 0) return null;
  return (
    <div className="banner banner-critical" role="alert" data-testid="health-banner">
      <strong>Sync health: {health.alerts.length} problem{health.alerts.length === 1 ? "" : "s"}.</strong>{" "}
      {health.alerts[0]?.message} <Link href="/health">See Sync health</Link>.
    </div>
  );
}

// R19: the stack is drawn in SOURCE_IDS order, so ERPNext is the segment nearest zero on its side and Unit B
// sits outside it. The legend and the tooltip list the sources top to bottom: Unit B export, then ERPNext.
const LEGEND_ORDER: readonly SourceId[] = [...SOURCE_IDS].reverse();
// Color follows the source, never its rank (PLAN "Source breakdown on the monthly chart (R19)").
const SERIES_COLOR: Record<SourceId, string> = { erpnext: "var(--series-1)", legacy_unit_b: "var(--series-2)" };
// The soft fill under each source's partial-month hatch.
const SERIES_SOFT: Record<SourceId, string> = { erpnext: "var(--series-1-soft)", legacy_unit_b: "var(--series-2-soft)" };
const SEGMENT_RADIUS = 4;

type ChartPoint = {
  label: string;
  month: string;
  revenueCents: number;
  invoices: number;
  partial: boolean;
  bySource: Record<SourceId, SourceRevenue>;
} & Record<SourceId, number>;

function RevenueView({ data, showPartial }: { data: MonthlyRevenue; showPartial: boolean }) {
  const isPartial = (month: { complete: boolean }) => showPartial && !month.complete;
  const partialText = `partial, through ${dateLabel(data.asOf.date)}`;
  const chartData: ChartPoint[] = data.months.map((month) => ({
    label: `${monthLabel(month.month).slice(0, 3)}${isPartial(month) ? "*" : ""}`,
    month: month.month,
    revenueCents: month.revenueCents,
    invoices: month.invoices,
    partial: isPartial(month),
    bySource: month.bySource,
    // The plotted values, in dollars; the exact figures stay in cents (data-cents, tooltip).
    erpnext: month.bySource.erpnext.revenueCents / 100,
    legacy_unit_b: month.bySource.legacy_unit_b.revenueCents / 100,
  }));
  const partialMonths = data.months.filter(isPartial);

  return (
    <>
      <PeriodSummary data={data} />
      <section className="card" aria-label="Monthly revenue chart">
        <ul className="chart-legend" aria-label="Sources">
          {LEGEND_ORDER.map((source) => (
            <li key={source}>
              <span className="swatch" style={{ background: SERIES_COLOR[source] }} aria-hidden="true" />
              {SOURCE_LABELS[source]}
            </li>
          ))}
        </ul>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="30%" stackOffset="sign">
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--border)" }} tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={64}
                tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
                tickFormatter={axisDollars}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ fill: "var(--grid)", opacity: 0.5 }}
                content={({ active, payload }) => {
                  const point = payload?.[0]?.payload as ChartPoint | undefined;
                  if (!active || !point) return null;
                  return <RevenueTooltip point={point} partialText={partialText} />;
                }}
              />
              {SOURCE_IDS.map((source) => (
                <Bar
                  key={source}
                  dataKey={source}
                  name={SOURCE_LABELS[source]}
                  stackId="rev"
                  fill={SERIES_COLOR[source]}
                  maxBarSize={48}
                  isAnimationActive={false}
                  shape={(props: BarShapeProps) => <Segment {...props} source={source} />}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        {partialMonths.length > 0 && (
          <p className="partial-note" data-testid="partial-note">
            <span className="swatch swatch-partial" aria-hidden="true" />* {partialMonths.map((m) => monthLabel(m.month)).join(", ")}:{" "}
            {partialText}. The month isn't over, so its bar is not comparable with complete months.
          </p>
        )}
        {/* The hatch patterns live in their own SVG; url(#partial-hatch-<source>) resolves document-wide.
            The stripes carry the 3:1 contrast against the card; the soft fill doesn't need to. */}
        <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
          <defs>
            {SOURCE_IDS.map((source) => (
              <pattern
                key={source}
                id={`partial-hatch-${source}`}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill={SERIES_SOFT[source]} />
                {/* A filled 2.5 px stripe inside the tile (a stroke centred on x=0 would be clipped to half). */}
                <rect width="2.5" height="6" fill={SERIES_COLOR[source]} />
              </pattern>
            ))}
          </defs>
        </svg>
      </section>

      <section className="card" aria-label="Monthly revenue table">
        <table>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className="num">
                Revenue (USD)
              </th>
              <th scope="col" className="num">
                Invoices
              </th>
            </tr>
          </thead>
          <tbody>
            {data.months.map((month) => (
              <tr key={month.month} data-testid={`row-${month.month}`}>
                <th scope="row">
                  {monthLabel(month.month)}
                  {isPartial(month) && (
                    <span className="badge badge-partial" data-testid={`partial-${month.month}`}>
                      {partialText}
                    </span>
                  )}
                </th>
                <td className="num" data-testid={`revenue-${month.month}`} aria-label={`Revenue ${monthLabel(month.month)}`}>
                  {formatUsdCents(month.revenueCents)}
                </td>
                <td className="num" data-testid={`invoices-${month.month}`} aria-label={`Invoices ${monthLabel(month.month)}`}>
                  {month.invoices}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td className="num" data-testid="revenue-total" aria-label="Revenue total">
                {formatUsdCents(data.total.revenueCents)}
              </td>
              <td className="num" data-testid="invoices-total" aria-label="Invoices total">
                {data.total.invoices}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </>
  );
}

// The Sync health breakdown covers the reconciliation's period (Q10); this page covers its own range.
const SYNC_HEALTH_MONTHS = monthsOfPeriod(reconciliationPeriod());

// R20, AC36: total revenue and its two sources for the page's period, each stating that period. The page
// never presents these as equal to the Sync health breakdown; it only says whether the periods are the same.
function PeriodSummary({ data }: { data: MonthlyRevenue }) {
  const coverage = periodCoverage({ from: data.from, to: data.to }, data.asOf.date);
  const range = `${monthLabel(coverage.firstMonth)} – ${monthLabel(coverage.lastMonth)}`;
  const period =
    coverage.dataThrough && coverage.partialMonth
      ? `${range}, data through ${dateLabel(coverage.dataThrough)} (${monthLabel(coverage.partialMonth)} partial)`
      : range;
  const samePeriod = data.from === SYNC_HEALTH_MONTHS.from && data.to === SYNC_HEALTH_MONTHS.to;
  return (
    <section className="card financial-summary" aria-label="Revenue for the period">
      <p className="financial-summary-period" data-testid="summary-period">
        Period: {period}
      </p>
      <dl className="financial-summary-figures">
        <div>
          <dt>Total revenue</dt>
          <dd data-testid="summary-total" data-cents={data.total.revenueCents}>
            {formatUsdCents(data.total.revenueCents)}
          </dd>
        </div>
        {SOURCE_IDS.map((source) => (
          <div key={source}>
            <dt>{SOURCE_LABELS[source]}</dt>
            <dd data-testid={`summary-${source}`} data-cents={data.total.bySource[source].revenueCents}>
              {formatUsdCents(data.total.bySource[source].revenueCents)}
              {data.total.bySource[source].invoices === 0 && <span className="muted"> · no invoices in period</span>}
            </dd>
          </div>
        ))}
      </dl>
      <p className="partial-note">
        {samePeriod
          ? "The breakdown on Sync health covers the same period."
          : `The breakdown on Sync health covers ${monthLabel(SYNC_HEALTH_MONTHS.from)} – ${monthLabel(SYNC_HEALTH_MONTHS.to)}, a different period, so the figures are not directly comparable.`}
      </p>
    </section>
  );
}

// Same height as PeriodSummary while loading; no figure test ids (R18).
function SkeletonSummary() {
  return (
    <div className="card financial-summary" aria-hidden="true">
      <span className="skeleton skeleton-line skeleton-line-short" />
      <div className="financial-summary-figures">
        {[0, 1, 2].map((index) => (
          <div key={index}>
            <span className="skeleton skeleton-line skeleton-line-short" />
            <span className="skeleton skeleton-value" />
          </div>
        ))}
      </div>
      <span className="skeleton skeleton-line" />
    </div>
  );
}

// One stacked segment (R19). The geometry (gaps, which end is rounded, the sliver of a thin segment) is the
// pure segmentGeometry, unit tested in tests/ui/stack-geometry.test.ts. A zero segment draws nothing.
function Segment(props: BarShapeProps & { source: SourceId }) {
  const point = props.payload as ChartPoint | undefined;
  if (!point) return <g />;
  const { source } = props;
  const cents = point.bySource[source].revenueCents;
  const geometry = segmentGeometry({
    values: SOURCE_IDS.map((id) => point.bySource[id].revenueCents),
    index: SOURCE_IDS.indexOf(source),
    y: props.y,
    height: props.height,
    radius: SEGMENT_RADIUS,
  });
  if (!geometry) return <g />;
  const { y0, y1, radiusTop, radiusBottom } = geometry;
  return (
    <path
      d={roundedRectPath(props.x, y0, props.width, y1 - y0, radiusTop, radiusBottom)}
      fill={point.partial ? `url(#partial-hatch-${source})` : SERIES_COLOR[source]}
      data-testid={`bar-${point.month}-${source}`}
      data-cents={cents}
      data-partial={point.partial ? "true" : "false"}
    />
  );
}

// A rectangle with its top corners rounded by rTop and its bottom corners by rBottom (clamped to fit).
function roundedRectPath(x: number, y: number, width: number, height: number, rTop: number, rBottom: number): string {
  const limit = Math.min(width / 2, height / 2);
  const t = Math.max(0, Math.min(rTop, limit));
  const b = Math.max(0, Math.min(rBottom, limit));
  const right = x + width;
  const bottom = y + height;
  return [
    `M ${x},${y + t}`,
    t ? `A ${t},${t} 0 0 1 ${x + t},${y}` : "",
    `L ${right - t},${y}`,
    t ? `A ${t},${t} 0 0 1 ${right},${y + t}` : "",
    `L ${right},${bottom - b}`,
    b ? `A ${b},${b} 0 0 1 ${right - b},${bottom}` : "",
    `L ${x + b},${bottom}`,
    b ? `A ${b},${b} 0 0 1 ${x},${bottom - b}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

// T24 (SPEC R16, AC20): the tooltip leads with the month's total, in a tag, and keeps the month and invoice
// count secondary. R19: the tag is neutral (blue means ERPNext now); then one line per source, in the
// legend's order, always both. Every text uses the theme text tokens, never a series color.
function RevenueTooltip({ point, partialText }: { point: ChartPoint; partialText: string }) {
  return (
    <div className="chart-tooltip" data-testid="revenue-tooltip">
      <div className="chart-tooltip-label">
        {monthLabel(point.month)}
        {point.partial ? ` · ${partialText}` : ""}
      </div>
      <div className="chart-tooltip-value">{formatUsdCents(point.revenueCents)}</div>
      <div className="chart-tooltip-caption">
        Revenue · {invoiceCount(point.invoices)}
      </div>
      <ul className="chart-tooltip-sources">
        {LEGEND_ORDER.map((source) => (
          <li key={source} data-testid={`tooltip-${source}`}>
            <span className="chart-tooltip-swatch" style={{ background: SERIES_COLOR[source] }} aria-hidden="true" />
            <span className="chart-tooltip-source">{SOURCE_LABELS[source]}</span>
            <span className="chart-tooltip-source-revenue">{formatUsdCents(point.bySource[source].revenueCents)}</span>
            <span className="chart-tooltip-source-invoices">{invoiceCount(point.bySource[source].invoices)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Y axis ticks in thousands of dollars, sign first: -$5k, $0k, $20k.
function axisDollars(value: number): string {
  const thousands = Math.round(Math.abs(value) / 1000);
  return `${value < 0 && thousands > 0 ? "-" : ""}$${thousands}k`;
}

function invoiceCount(invoices: number): string {
  return `${invoices} invoice${invoices === 1 ? "" : "s"}`;
}
