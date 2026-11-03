// Public demo (src/http/demo-mode.ts): a static page over app/demo/snapshot.json, figures copied once from the live
// pipeline by scripts/demo/export-snapshot.ts. No fetch, no client component, no Supabase: it never reads or writes a
// database, so it renders with no environment at all.
import { Fragment } from "react";
import type { DemoSnapshot } from "../../src/demo/snapshot.ts";
import { buildDemoView } from "../../src/demo/view.ts";
import snapshot from "./snapshot.json" with { type: "json" };

export const metadata = {
  title: "ERP Revenue Sync — public demo",
  description: "Two sources, one canonical revenue model: a static sample of the pipeline's figures.",
};

const REPO = "https://github.com/FigueiredoFelipe/erp-sync-lab";

const PIPELINE = [
  ["Sources", "ERPNext over its REST API (polling and webhooks) and a legacy CSV export with no API."],
  ["Adapters", "One adapter per source maps its format into a single canonical invoice."],
  ["Validation", "Records that fail a business rule go to quarantine with a reason code; nothing is half-loaded."],
  ["Queue and workers", "Changes travel through a queue; failed messages retry and then land in a dead-letter queue."],
  ["Postgres", "Canonical invoices with row-level security; revenue views per month, source and customer."],
  ["Reconciliation", "A daily job compares the totals stored here with the totals in the source."],
] as const;

export default function DemoPage() {
  const view = buildDemoView(snapshot as DemoSnapshot);
  return (
    <main>
      <div className="banner banner-ok" role="note">
        <strong>Static sample.</strong> Figures frozen from the live pipeline on {view.frozenOn}. This page never reads
        or writes a database.
      </div>

      <h1>ERP Revenue Sync</h1>
      <p>
        Revenue lives in two systems that disagree on customer names, formats and sometimes totals. This project syncs
        both into one canonical model so finance sees one trusted number per customer and month, with every figure
        traceable to its source document. The company, customers and invoices are fictional.
      </p>

      <section className="stats" aria-label="Totals">
        <div className="card">
          <div className="stat-label">Revenue, Jan–Oct 2026</div>
          <div className="stat-value num">{view.total.total}</div>
        </div>
        <div className="card">
          <div className="stat-label">Invoices loaded</div>
          <div className="stat-value num">{view.total.invoices}</div>
        </div>
        <div className="card">
          <div className="stat-label">In quarantine</div>
          <div className="stat-value num">{view.quarantineCount}</div>
        </div>
      </section>

      <section className="card">
        <h2>How it works</h2>
        <ol>
          {PIPELINE.map(([name, text]) => (
            <li key={name}>
              <strong>{name}.</strong> {text}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>Revenue by month</h2>
        <p className="muted">As of {view.asOf}. A partial month is marked so half a month never looks like a whole one.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">ERPNext</th>
                <th scope="col" className="num">Legacy export</th>
                <th scope="col" className="num">Total</th>
                <th scope="col" className="num">Invoices</th>
              </tr>
            </thead>
            <tbody>
              {view.months.map((m) => (
                <tr key={m.label}>
                  <th scope="row">
                    {m.label}
                    {m.partial && <span className="badge badge-partial"> partial</span>}
                  </th>
                  <td className="num">{m.erpnext}</td>
                  <td className="num">{m.legacy}</td>
                  <td className="num">{m.total}</td>
                  <td className="num">{m.invoices}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="num">{view.total.erpnext}</td>
                <td className="num">{view.total.legacy}</td>
                <td className="num">{view.total.total}</td>
                <td className="num">{view.total.invoices}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Top customers</h2>
        <p className="muted">Names from both sources resolved to one customer through a versioned mapping.</p>
        <div className="table-scroll compact">
          <table>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="num">Revenue</th>
                <th scope="col" className="num">Invoices</th>
              </tr>
            </thead>
            <tbody>
              {view.customers.map((c) => (
                <tr key={c.name}>
                  <th scope="row">{c.name}</th>
                  <td className="num">{c.total}</td>
                  <td className="num">{c.invoices}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Quarantine</h2>
        <p className="muted">Bad records are held back with a reason instead of being summed into the totals.</p>
        <ul>
          {view.quarantine.map((q) => (
            <li key={q.code}>
              {q.reason}: {q.count}
            </li>
          ))}
        </ul>
        <div className="table-scroll compact">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Document</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {view.quarantineExamples.map((e) => (
                <tr key={`${e.source}-${e.document}`}>
                  <td>{e.source}</td>
                  <td>{e.document}</td>
                  <td>{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Sync health at snapshot time</h2>
        <dl className="kv stack">
          {view.health.map((h) => (
            <Fragment key={h.label}>
              <dt>{h.label}</dt>
              <dd>{h.value}</dd>
            </Fragment>
          ))}
          <dt>Last successful reconciliation</dt>
          <dd>{view.reconciliation}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Run it yourself</h2>
        <p>
          The full pipeline, the signed-in dashboard, the tests and the spec-driven documents (constitution, spec, plan,
          tasks) are in the <a href={REPO}>repository</a>. The README explains how to run it locally.
        </p>
      </section>
    </main>
  );
}
