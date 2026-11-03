// Public demo (src/http/demo-mode.ts): a static page over app/demo/snapshot.json, figures copied once from the live
// pipeline by scripts/demo/export-snapshot.ts. No fetch, no client component, no Supabase: it never reads or writes a
// database, so it renders with no environment at all. Colors follow the dashboard: blue = ERPNext, orange = legacy
// export, red = quarantine, green = reconciled.
import type { DemoSnapshot } from "../../src/demo/snapshot.ts";
import { buildDemoView, type DemoView } from "../../src/demo/view.ts";
import styles from "./demo.module.css";
import snapshot from "./snapshot.json" with { type: "json" };

export const metadata = {
  title: "ERP Revenue Sync — public demo",
  description: "Two systems that disagree, one trusted revenue number: a static sample of the pipeline's figures.",
};

const REPO = "https://github.com/FigueiredoFelipe/erp-sync-lab";

// Inline SVG, rendered on the server: stacked revenue per month, ERPNext at the bottom, legacy on top.
function RevenueChart({ view }: { view: DemoView }) {
  const W = 640;
  const H = 260;
  const left = 46;
  const bottom = 26;
  const top = 18;
  const step = 20_000_00;
  const ceiling = Math.max(step, Math.ceil(view.maxMonthCents / step) * step);
  const y = (cents: number) => top + (H - top - bottom) * (1 - cents / ceiling);
  const slot = (W - left - 8) / view.months.length;
  const bw = Math.min(38, slot * 0.62);
  const ticks = Array.from({ length: ceiling / step + 1 }, (_, i) => i * step);
  return (
    <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="chart-title chart-desc">
      <title id="chart-title">Revenue by month and source, January to October 2026</title>
      <desc id="chart-desc">
        Each bar stacks ERPNext revenue (blue) under legacy-export revenue (orange). October is partial. Total {view.total.total}.
      </desc>
      <defs>
        <pattern id="partial" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="6" fill="var(--surface-1)" opacity="0.55" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={W - 4} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          <text x={left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)">
            ${t / 100_000}k
          </text>
        </g>
      ))}
      {view.months.map((m, i) => {
        const x = left + i * slot + (slot - bw) / 2;
        const yErp = y(m.erpnextCents);
        const yTop = y(m.totalCents);
        return (
          <g key={m.label}>
            <rect x={x} y={yErp} width={bw} height={y(0) - yErp} rx="3" fill="var(--series-1)" />
            <rect x={x} y={yTop} width={bw} height={yErp - yTop} rx="3" fill="var(--series-2)" />
            {m.partial && <rect x={x} y={yTop} width={bw} height={y(0) - yTop} fill="url(#partial)" />}
            <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-secondary)">
              {m.short}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function DemoPage() {
  const view = buildDemoView(snapshot as DemoSnapshot);
  const topCustomer = Math.max(1, ...view.customers.map((c) => c.totalCents));
  const topReason = Math.max(1, ...view.quarantine.map((q) => q.count));
  return (
    <main className={styles.page}>
      <p className={styles.topLink}>
        <a href={REPO}>View the code on GitHub</a>
      </p>
      <p className={styles.note} role="note">
        Static sample of a fictional company. Figures frozen from the live pipeline on {view.frozenOn}; this page never
        reads or writes a database.
      </p>

      <h1 className={styles.title}>Two systems that disagree. One revenue number finance can trust.</h1>
      <p className={styles.lede}>
        An ERPNext instance and a legacy CSV export spell customers differently, format dates differently and sometimes
        disagree on totals. This pipeline merges both into one canonical model, holds back bad records, and proves the
        result against the source every day.
      </p>

      <div className={styles.equation} aria-label={`ERPNext ${view.total.erpnext} plus legacy export ${view.total.legacy} equals ${view.total.total}`}>
        <div className={`${styles.term} ${styles.erp}`}>
          <strong>{view.total.erpnext}</strong>
          <span>ERPNext, via REST API</span>
        </div>
        <span className={styles.op} aria-hidden="true">+</span>
        <div className={`${styles.term} ${styles.legacy}`}>
          <strong>{view.total.legacy}</strong>
          <span>Legacy CSV export</span>
        </div>
        <span className={styles.op} aria-hidden="true">=</span>
        <div className={`${styles.term} ${styles.sum}`}>
          <strong>{view.total.total}</strong>
          <span>{view.total.invoices} invoices, Jan–Oct 2026</span>
        </div>
      </div>

      <section className={styles.panel} aria-labelledby="by-month">
        <h2 id="by-month" className={styles.panelTitle}>Revenue by month</h2>
        <p className={styles.caption}>As of {view.asOf}. October is hatched: half a month never passes for a whole one.</p>
        <div className={styles.chartScroll}>
          <RevenueChart view={view} />
        </div>
        <ul className={styles.legend}>
          <li><span className={styles.swatch} style={{ background: "var(--series-1)" }} /> ERPNext</li>
          <li><span className={styles.swatch} style={{ background: "var(--series-2)" }} /> Legacy export</li>
        </ul>
        <details className={styles.numbers}>
          <summary>Show the numbers</summary>
          <table>
            <thead>
              <tr><th scope="col">Month</th><th scope="col">ERPNext</th><th scope="col">Legacy</th><th scope="col">Total</th></tr>
            </thead>
            <tbody>
              {view.months.map((m) => (
                <tr key={m.label}>
                  <td>{m.label}{m.partial ? " (partial)" : ""}</td><td>{m.erpnext}</td><td>{m.legacy}</td><td>{m.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className={styles.panel} aria-labelledby="pipeline">
        <h2 id="pipeline" className={styles.panelTitle}>How a record gets here</h2>
        <p className={styles.caption}>Every invoice takes the same path, whichever system it came from.</p>
        <div className={styles.flow}>
          <div className={styles.sources}>
            <div className={`${styles.node} ${styles.nodeErp}`}><b>ERPNext</b><small>REST polling and webhooks</small></div>
            <div className={`${styles.node} ${styles.nodeLegacy}`}><b>Legacy export</b><small>CSV files, no API</small></div>
          </div>
          <span className={styles.arrow} aria-hidden="true">→</span>
          <div className={styles.node}><b>Adapters</b><small>one per source, into one canonical invoice</small></div>
          <span className={styles.arrow} aria-hidden="true">→</span>
          <div>
            <div className={styles.node}><b>Validation</b><small>business rules, all or nothing</small></div>
            <div className={styles.branch}>{view.quarantineCount} held in quarantine</div>
          </div>
          <span className={styles.arrow} aria-hidden="true">→</span>
          <div className={styles.done}>
            <b>Reconciled</b>
            <small>Queue, Postgres with row-level security, daily check against the source</small>
          </div>
        </div>
      </section>

      <div className={styles.pair}>
        <section className={styles.panel} aria-labelledby="customers">
          <h2 id="customers" className={styles.panelTitle}>Top customers</h2>
          <p className={styles.caption}>Different spellings in each system resolve to one customer through a versioned mapping.</p>
          <ul className={styles.bars}>
            {view.customers.map((c) => (
              <li key={c.name} className={styles.bar}>
                <span>{c.name}</span>
                <span>{c.total}</span>
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fillTotal} style={{ width: `${(100 * c.totalCents) / topCustomer}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.panel} aria-labelledby="quarantine">
          <h2 id="quarantine" className={styles.panelTitle}>Quarantine</h2>
          <p className={styles.caption}>Bad records wait here with a reason instead of being summed into the totals.</p>
          <ul className={styles.bars}>
            {view.quarantine.map((q) => (
              <li key={q.code} className={styles.bar}>
                <span>{q.reason}</span>
                <span>{q.count}</span>
                <div className={styles.track} aria-hidden="true">
                  <div className={styles.fillBad} style={{ width: `${(100 * q.count) / topReason}%` }} />
                </div>
              </li>
            ))}
          </ul>
          <p className={styles.docs}>
            Held documents: {view.quarantineExamples.map((e, i) => (
              <span key={e.document}>{i > 0 && ", "}<code>{e.document}</code></span>
            ))}
          </p>
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="health">
        <h2 id="health" className={styles.panelTitle}>Sync health when the snapshot was taken</h2>
        <dl className={styles.health}>
          {view.health.map((h) => (
            <div key={h.label}>
              <dt>{h.label}</dt>
              <dd><span className={styles.dot} aria-hidden="true" />{h.value}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.matched}>{view.reconciled ? "Reconciled: " : ""}{view.reconciliation}</p>
      </section>

      <section className={styles.ctaPanel} aria-labelledby="code">
        <div>
          <h2 id="code" className={styles.ctaTitle}>The whole system is open source</h2>
          <p className={styles.ctaText}>
            Adapters, quarantine rules, queue and workers, reconciliation, the signed-in dashboard, 1,000+ tests and the
            spec-driven documents behind every decision. Clone it and run it locally.
          </p>
        </div>
        <div className={styles.ctaActions}>
          <a className={styles.ctaPrimary} href={REPO}>View the code on GitHub</a>
          <a className={styles.ctaSecondary} href={`${REPO}/tree/main/specs`}>Read the specs</a>
        </div>
      </section>
    </main>
  );
}
