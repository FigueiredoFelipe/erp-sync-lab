"use client";

// Open quarantine (R09, US04): every rejected record with its source, document, reason code and dates.
// None of these is in the figures. Stable data-testids: quarantine-count, quarantine-row-<source>-<doc>,
// reason-count-<CODE>.
import { useEffect, useState } from "react";
import { formatTimestamp } from "../../src/core/timestamp.ts";
import type { QuarantineList } from "../../src/services/quarantine-service.ts";
import { REASON_CODES } from "../../src/services/quarantine-service.ts";
import { DataRegion } from "../_components/data-region.tsx";
import { fetchJson, type Load } from "../_components/fetch-json.ts";
import { pageReady, regionReady } from "../_components/load-state.ts";
import { BusyMark, SkeletonTable } from "../_components/skeleton.tsx";
import type { SourceId } from "../../src/core/canonical.ts";
import { SOURCE_LABELS } from "../_components/sources.ts";


export default function QuarantinePage() {
  const [source, setSource] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<Load<QuarantineList>>({ state: "loading" });
  // Bumped by "Try again": re-runs only the list's load with the same filters.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSource(params.get("source") ?? "");
    setReason(params.get("reason") ?? "");
  }, []);

  useEffect(() => {
    if (source === null) return;
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (reason) params.set("reason", reason);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    setResult({ state: "loading" });
    // Last request wins: a filter change or a retry marks the previous request stale.
    let stale = false;
    fetchJson<QuarantineList>(`/api/quarantine${query ? `?${query}` : ""}`)
      .then((data) => {
        if (!stale) setResult({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (stale) return;
        console.error("Failed to load the quarantine", error);
        setResult({ state: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      stale = true;
    };
  }, [source, reason, attempt]);

  // R17: a filter change marks the load in the same render, before the effect fetches.
  function changeFilter(set: (value: string) => void, value: string) {
    setResult({ state: "loading" });
    set(value);
  }

  // R18: the region goes to loading in the click handler, then only the list is fetched again.
  function retry() {
    setResult({ state: "loading" });
    setAttempt((n) => n + 1);
  }

  return (
    <main className="wide" data-page="quarantine" data-ready={pageReady(regionReady(result))}>
      <h1>Quarantine</h1>
      <p className="as-of">
        Records that failed validation. They are <strong>not</strong> in any figure until the source is fixed and they pass.
      </p>

      <div className="card filters" role="group" aria-label="Filters">
        <label>
          Source
          <select data-testid="filter-source" value={source ?? ""} onChange={(e) => changeFilter(setSource, e.target.value)}>
            <option value="">All sources</option>
            <option value="erpnext">{SOURCE_LABELS["erpnext"]}</option>
            <option value="legacy_unit_b">{SOURCE_LABELS["legacy_unit_b"]}</option>
          </select>
        </label>
        <label>
          Reason
          <select data-testid="filter-reason" value={reason} onChange={(e) => changeFilter(setReason, e.target.value)}>
            <option value="">All reasons</option>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <BusyMark active={result.state === "loading"} />
      </div>

      {/* Keeps the quarantine-error test id on the failed state; the region's error box says what failed. */}
      <div data-testid={result.state === "error" ? "quarantine-error" : undefined}>
        <DataRegion
          what="the quarantine"
          load={result}
          onRetry={retry}
          testId="region-quarantine"
          placeholder={<SkeletonTable rows={5} columns={6} heading />}
        >
          {(data) => <QuarantineTable data={data} />}
        </DataRegion>
      </div>
    </main>
  );
}

function QuarantineTable({ data }: { data: QuarantineList }) {
  return (
    <section className="card" aria-label="Open quarantine">
      <h2>
        <span data-testid="quarantine-count">{data.count}</span> open {data.count === 1 ? "record" : "records"}
        {data.byReason.length > 0 && (
          <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem", marginLeft: 8 }}>
            {data.byReason.map((r, i) => (
              <span key={r.reasonCode}>
                {i > 0 ? " · " : ""}
                {r.reasonCode} <span data-testid={`reason-count-${r.reasonCode}`}>{r.count}</span>
              </span>
            ))}
          </span>
        )}
      </h2>
      {data.entries.length === 0 ? (
        <p className="empty" data-testid="quarantine-empty">
          Nothing in quarantine for these filters.
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Document</th>
                <th scope="col">Customer (as in source)</th>
                <th scope="col">Reason</th>
                <th scope="col">Detail</th>
                <th scope="col">Rejected</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={`${entry.source}-${entry.sourceDocId}`} data-testid={`quarantine-row-${entry.source}-${entry.sourceDocId}`}>
                  <td>{SOURCE_LABELS[entry.source as SourceId] ?? entry.source}</td>
                  <td>{entry.sourceDocId}</td>
                  <td>{entry.sourceCustomer ?? <span className="muted">—</span>}</td>
                  <td>
                    <code>{entry.reasonCode}</code>
                  </td>
                  <td>{entry.detail ?? <span className="muted">—</span>}</td>
                  <td title={`First rejected ${formatTimestamp(entry.firstRejectedAt)}`}>{formatTimestamp(entry.lastRejectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
