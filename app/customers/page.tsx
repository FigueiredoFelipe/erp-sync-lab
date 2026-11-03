"use client";

// Revenue per customer (R08, US02): filters by source, customer and month range; one row per customer,
// both sources combined unless a source is picked. Stable data-testids for agent-driven verification:
// customer-row-<key>, cust-<key>-<YYYY-MM>, cust-<key>-total, trend-<key>, customers-total, partial-col-<YYYY-MM>.
// Drill-down (R12, T23): a month figure opens the documents behind it (drill-total, drill-doc-<source>-<id>).
// The trend (BR08, T20) always uses the customer's whole history from both sources, whatever the filters.
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { formatUsdCents } from "../../src/core/money.ts";
import type { Trend } from "../../src/core/trend/trend.ts";
import type { CustomerOption, CustomerRevenue } from "../../src/services/customer-revenue-service.ts";
import type { CustomerMonthDocuments } from "../../src/services/documents-service.ts";
import { DataRegion } from "../_components/data-region.tsx";
import { dateLabel, fetchJson, monthLabel, type Load } from "../_components/fetch-json.ts";
import { isSameRequest, pageReady, regionReady, type Ready } from "../_components/load-state.ts";
import { BusyMark, SkeletonTable } from "../_components/skeleton.tsx";
import { SOURCE_LABELS, shortSourceLabel } from "../_components/sources.ts";
import { TableScroll } from "../_components/table-scroll.tsx";
import { trendSymbol, trendTipId } from "../_components/trend-symbols.ts";

interface Filters {
  source: string;
  customer: string;
  from: string;
  to: string;
}

const DEFAULT_FILTERS: Filters = {
  source: "",
  customer: "",
  from: "2026-01",
  to: "2026-10",
};

// R18: the drill-down's region state, reported up to <main data-ready>; null = no drill-down open.
type OnReady = Dispatch<SetStateAction<Ready | null>>;
type BusyControl = "apply" | "reset" | null;

function filtersFromUrl(): Filters {
  const params = new URLSearchParams(window.location.search);
  return {
    source: params.get("source") ?? DEFAULT_FILTERS.source,
    customer: params.get("customer") ?? DEFAULT_FILTERS.customer,
    from: params.get("from") ?? DEFAULT_FILTERS.from,
    to: params.get("to") ?? DEFAULT_FILTERS.to,
  };
}

function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}

// Months shown for a range, so the loading table has the loaded table's shape (one column per month).
function monthCount(from: string, to: string): number {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const count = index(to) - index(from) + 1;
  return Number.isFinite(count) && count >= 1 ? Math.min(count, 24) : 10;
}

function optionLabel(option: CustomerOption): string {
  return `${option.name}${option.mapped ? "" : ` (unmapped, ${shortSourceLabel(option.key.split(":")[1] ?? "")})`}`;
}

export default function CustomersPage() {
  const [filters, setFilters] = useState<Filters | null>(null);
  const [draft, setDraft] = useState<Filters>(DEFAULT_FILTERS);
  const [result, setResult] = useState<Load<CustomerRevenue>>({
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<BusyControl>(null);
  const [drill, setDrill] = useState<Ready | null>(null);
  // The last loaded customer list and every name seen, so the Customer select keeps its values while loading.
  const [lastOptions, setLastOptions] = useState<CustomerOption[]>([]);
  const [knownNames, setKnownNames] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial = filtersFromUrl();
    setFilters(initial);
    setDraft(initial);
  }, []);

  // Every trigger (first load, Apply, Reset, Try again) sets the region to loading in its own handler;
  // the effect only fetches. The stale guard makes the last request win.
  useEffect(() => {
    if (!filters) return;
    let stale = false;
    fetchJson<CustomerRevenue>(`/api/revenue/customers?${toQuery(filters)}`)
      .then((data) => {
        if (stale) return;
        setResult({ state: "ok", data });
        setLastOptions(data.customerOptions);
        setKnownNames((names) => {
          const next = { ...names };
          for (const option of data.customerOptions) next[option.key] = optionLabel(option);
          return next;
        });
        setBusy(null);
      })
      .catch((error: unknown) => {
        if (stale) return;
        console.error("Failed to load customer revenue", error);
        setResult({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        setBusy(null);
      });
    return () => {
      stale = true;
    };
  }, [filters, attempt]);

  const appliedQuery = filters ? toQuery(filters) : null;

  // Apply and Reset mark the load in the same render (R18), before the effect fetches. The same request
  // already shown or in flight does nothing; after a failure it is a retry.
  function load(next: Filters, control: Exclude<BusyControl, null>) {
    const query = toQuery(next);
    if (appliedQuery !== null && isSameRequest(query, appliedQuery, result.state)) return;
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    setBusy(control);
    setResult({ state: "loading" });
    setFilters({ ...next });
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    load(draft, "apply");
  }

  function reset() {
    setDraft(DEFAULT_FILTERS);
    load(DEFAULT_FILTERS, "reset");
  }

  function retry() {
    setResult({ state: "loading" });
    setAttempt((n) => n + 1);
  }

  const options = result.state === "ok" ? result.data.customerOptions : lastOptions;
  // A selected customer not in the list (a ?customer= deep link before the first load, or a customer the
  // new result lacks) still shows, by its last known name or its key.
  const missingSelected = draft.customer !== "" && !options.some((option) => option.key === draft.customer);
  const columns = monthCount(filters?.from ?? draft.from, filters?.to ?? draft.to) + 3;
  const ready = pageReady(regionReady(result), drill);

  return (
    <main className="wide wide-table" data-page="customers" data-ready={ready}>
      <h1>Revenue by customer</h1>
      <p className="as-of">
        Monthly net revenue per customer (after discounts, before tax). Credit notes count negative in their own month.
      </p>

      <form className="card filters" onSubmit={apply} aria-label="Filters">
        <label>
          Source
          <select data-testid="filter-source" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
            <option value="">All sources</option>
            <option value="erpnext">{SOURCE_LABELS["erpnext"]}</option>
            <option value="legacy_unit_b">{SOURCE_LABELS["legacy_unit_b"]}</option>
          </select>
        </label>
        <label>
          Customer
          <select data-testid="filter-customer" value={draft.customer} onChange={(e) => setDraft({ ...draft, customer: e.target.value })}>
            <option value="">All customers</option>
            {missingSelected && <option value={draft.customer}>{knownNames[draft.customer] ?? draft.customer}</option>}
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input data-testid="filter-from" type="month" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label>
          To
          <input data-testid="filter-to" type="month" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <div className="filter-actions">
          <button type="submit" data-testid="filter-apply" aria-busy={busy === "apply" ? true : undefined}>
            Apply
            <BusyMark active={busy === "apply"} />
          </button>
          <button type="button" onClick={reset} data-testid="filter-reset" aria-busy={busy === "reset" ? true : undefined}>
            Reset
            <BusyMark active={busy === "reset"} />
          </button>
        </div>
      </form>

      <DataRegion
        what="customer revenue"
        load={result}
        onRetry={retry}
        testId="region-customers"
        placeholder={<SkeletonTable rows={8} columns={columns} variant="customers" />}
      >
        {(data) => <CustomerTable key={appliedQuery ?? ""} data={data} onReady={setDrill} />}
      </DataRegion>
    </main>
  );
}

interface Selection {
  key: string;
  name: string;
  month: string;
  figureCents: number;
}

function CustomerTable({ data, onReady }: { data: CustomerRevenue; onReady: OnReady }) {
  const [selected, setSelected] = useState<Selection | null>(null);
  // Only one trend tooltip is open at a time: the last badge hovered, focused or tapped owns it.
  const [openTip, setOpenTip] = useState<string | null>(null);
  if (data.customers.length === 0) {
    return (
      <section className="card">
        <p className="empty" data-testid="customers-empty">
          No revenue for these filters.
        </p>
      </section>
    );
  }
  const partialText = `partial, through ${dateLabel(data.asOf.date)}`;

  return (
    <section className="card customers-card" aria-label="Revenue by customer table">
      {/* R21: customer, total and trend stay fixed; only the months scroll, under the mirror bar and cues. */}
      <TableScroll label="Monthly revenue by customer, scrolls sideways" what="months" testIdPrefix="customers" fixedEnd={2}>
        <table className="customers-table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              {data.months.map((m) => (
                <th
                  key={m.month}
                  scope="col"
                  className="num month-cell"
                  title={m.complete ? undefined : partialText}
                  data-testid={m.complete ? undefined : `partial-col-${m.month}`}
                >
                  {monthLabel(m.month).slice(0, 3)}
                  {m.complete ? "" : "*"}
                </th>
              ))}
              <th scope="col" className="num">
                Total
              </th>
              <th scope="col">Trend</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.map((customer) => (
              <tr key={customer.key} data-testid={`customer-row-${customer.key}`}>
                <th scope="row">
                  <span className="customer-name">
                    {customer.name}
                    {!customer.mapped && <span className="unmapped">(unmapped)</span>}
                  </span>
                </th>
                {customer.months.map((m) => (
                  <td key={m.month} className={`num month-cell${m.revenueCents === 0 && m.invoices === 0 ? " muted" : ""}`}>
                    {m.invoices === 0 ? (
                      <span data-testid={`cust-${customer.key}-${m.month}`}>{formatUsdCents(m.revenueCents)}</span>
                    ) : (
                      <button
                        type="button"
                        className="link"
                        data-testid={`cust-${customer.key}-${m.month}`}
                        aria-pressed={selected?.key === customer.key && selected.month === m.month}
                        title={`Show the ${m.invoices} document${m.invoices === 1 ? "" : "s"} behind this figure`}
                        onClick={() => {
                          // The figure already open: nothing to load, so no refetch and no busy state.
                          if (selected?.key === customer.key && selected.month === m.month) return;
                          onReady("false");
                          setSelected({
                            key: customer.key,
                            name: customer.name,
                            month: m.month,
                            figureCents: m.revenueCents,
                          });
                        }}
                      >
                        {formatUsdCents(m.revenueCents)}
                      </button>
                    )}
                  </td>
                ))}
                <td className="num" data-testid={`cust-${customer.key}-total`}>
                  {formatUsdCents(customer.total.revenueCents)}
                </td>
                <TrendCell
                  customerKey={customer.key}
                  trend={customer.trend}
                  active={openTip === customer.key}
                  onActivate={setOpenTip}
                />
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              {data.months.map((m) => (
                <td key={m.month} className="num month-cell" data-testid={`customers-month-${m.month}`}>
                  {formatUsdCents(m.revenueCents)}
                </td>
              ))}
              <td className="num" data-testid="customers-total">
                {formatUsdCents(data.total.revenueCents)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </TableScroll>
      {data.months.some((m) => !m.complete) && (
        <p className="partial-note" data-testid="partial-note">
          * {partialText}: the month isn&apos;t over.
        </p>
      )}
      {selected && (
        // Keyed by customer and month: a new selection mounts in loading in the same render, so the previous
        // documents (and a false drill-mismatch against the new figure) never show.
        <DrillDown
          key={`${selected.key}|${selected.month}`}
          selection={selected}
          source={data.source}
          onClose={() => setSelected(null)}
          onReady={onReady}
        />
      )}
      <p className="partial-note">
        Click a monthly figure to see the source documents behind it. Trend compares the last 3 complete months (
        {monthLabel(firstTrend(data).last3[0])}–{monthLabel(firstTrend(data).last3[1])}) with the 3 before them, both sources combined, at
        the as-of date {dateLabel(data.asOf.date)}: growing above +15%, declining below −15%; churned after 2 empty months; new when the
        first purchase is in the last 3.
      </p>
    </section>
  );
}

function firstTrend(data: CustomerRevenue): Trend {
  return (data.customers[0] as CustomerRevenue["customers"][number]).trend;
}

// AC40: label and symbol (the symbol hidden from screen readers, so the label is announced once); the
// explanation is a tooltip reachable by hover, keyboard focus and tap, closed with Escape, never a title.
function TrendCell({
  customerKey,
  trend,
  active,
  onActivate,
}: {
  customerKey: string;
  trend: Trend;
  // This cell owns the table's one open tooltip.
  active: boolean;
  onActivate: (key: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const badge = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const wants = !dismissed && (hovered || focused || pinned);
  const open = wants && active;
  const tipId = trendTipId(customerKey);

  // Another badge took the tooltip: a tap-pinned one here lets go, so it doesn't reopen later on its own.
  useEffect(() => {
    if (!active) setPinned(false);
  }, [active]);

  // The tooltip is fixed to the viewport, so the table's sideways scroller never clips it: below the badge,
  // right-aligned with it, flipped above when there is no room, kept inside the viewport. Placed before paint
  // and again on any scroll or resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = badge.current;
      const box = tip.current;
      if (!anchor || !box) return;
      const gap = 6;
      const edge = 8;
      const rect = anchor.getBoundingClientRect();
      const size = box.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const left = Math.min(Math.max(rect.right - size.width, edge), Math.max(width - size.width - edge, edge));
      const below = rect.bottom + gap + size.height <= height - edge || rect.top - gap - size.height < edge;
      box.style.left = `${left}px`;
      box.style.top = `${below ? rect.bottom + gap : rect.top - gap - size.height}px`;
      box.dataset["place"] = below ? "below" : "above";
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // A tap opens it until the next tap or a tap elsewhere (touch has no hover and may not move focus).
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setPinned(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  // Escape closes it wherever focus is, as long as it is open (WCAG 1.4.13, dismissible).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDismissed(true);
      setPinned(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <td className={open ? "trend-cell trend-cell-open" : "trend-cell"}>
      <span
        ref={wrap}
        className="trend-wrap"
        // Kept open while the pointer is over the badge or the tooltip itself.
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          setDismissed(false);
          setHovered(true);
          onActivate(customerKey);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setHovered(false);
        }}
      >
        <button
          ref={badge}
          type="button"
          className={`trend trend-${trend.label}`}
          aria-describedby={tipId}
          onFocus={(event) => {
            setDismissed(false);
            const visible = event.currentTarget.matches(":focus-visible");
            setFocused(visible);
            if (visible) onActivate(customerKey);
          }}
          onBlur={() => {
            setFocused(false);
            setPinned(false);
          }}
          onClick={() => {
            setDismissed(false);
            setPinned((value) => !value);
            onActivate(customerKey);
          }}
        >
          <span className="trend-symbol" aria-hidden="true">
            {trendSymbol(trend.label)}
          </span>
          <span data-testid={`trend-${customerKey}`}>{trend.label}</span>
        </button>
        <span ref={tip} role="tooltip" id={tipId} className="trend-tip" data-open={open}>
          {trendTitle(trend)}
        </span>
      </span>
    </td>
  );
}

function trendTitle(trend: Trend): string {
  const window = (w: [string, string]) => `${monthLabel(w[0]).slice(0, 3)}–${monthLabel(w[1])}`;
  return `${window(trend.prev3)}: ${formatUsdCents(trend.prev3Cents)} → ${window(trend.last3)}: ${formatUsdCents(trend.last3Cents)} (BR08 rule ${trend.rule})`;
}

function DrillDown({
  selection,
  source,
  onClose,
  onReady,
}: {
  selection: Selection;
  source: string | null;
  onClose: () => void;
  onReady: OnReady;
}) {
  const [docs, setDocs] = useState<Load<CustomerMonthDocuments>>({
    state: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({
      customer: selection.key,
      month: selection.month,
    });
    // Same source filter as the figure, so the documents add up to the number that was clicked.
    if (source) params.set("source", source);
    let stale = false;
    fetchJson<CustomerMonthDocuments>(`/api/revenue/documents?${params.toString()}`)
      .then((data) => {
        if (!stale) setDocs({ state: "ok", data });
      })
      .catch((error: unknown) => {
        if (stale) return;
        console.error("Failed to load source documents", error);
        setDocs({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      stale = true;
    };
    // Only the customer and month pick the documents; the Selection object itself may be recreated.
  }, [selection.key, selection.month, source, attempt]);

  // The opening click already reported "false"; this reports how the load ended, and closing clears it.
  useEffect(() => {
    onReady(regionReady(docs));
  }, [docs, onReady]);
  useEffect(() => () => onReady(null), [onReady]);

  // "Try again" repeats only the documents load.
  function retry() {
    setDocs({ state: "loading" });
    setAttempt((n) => n + 1);
  }

  return (
    <section className="drill" aria-label="Source documents" data-testid="drill">
      <h2>
        {selection.name}, {monthLabel(selection.month)}
        {source ? ` (${shortSourceLabel(source)} only)` : ""}{" "}
        <button type="button" onClick={onClose} data-testid="drill-close">
          Close
        </button>
      </h2>
      <DataRegion
        what="source documents"
        load={docs}
        onRetry={retry}
        testId="region-drill"
        placeholder={<SkeletonTable rows={3} columns={5} />}
      >
        {(data) => (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Document</th>
                    <th scope="col">Invoice date</th>
                    <th scope="col">Customer (as in source)</th>
                    <th scope="col" className="num">
                      Net total (USD)
                    </th>
                  </tr>
                </thead>
                {data.documents.map((doc) => (
                  <tbody key={`${doc.source}-${doc.sourceDocId}`}>
                    <tr data-testid={`drill-doc-${doc.source}-${doc.sourceDocId}`}>
                      <td>{shortSourceLabel(doc.source)}</td>
                      <td title={doc.rawRef}>
                        {doc.sourceDocId}
                        {doc.isCreditNote && <span className="badge badge-partial">credit note</span>}
                      </td>
                      <td>{dateLabel(doc.invoiceDate)}</td>
                      <td>{doc.sourceCustomer}</td>
                      <td className="num" data-testid={`drill-amount-${doc.source}-${doc.sourceDocId}`}>
                        {formatUsdCents(doc.amountCents)}
                      </td>
                    </tr>
                    {doc.lines.map((line) => (
                      <tr key={line.lineNo} className="lines">
                        <td />
                        <td colSpan={3}>
                          {line.lineNo}. {line.description ?? line.itemCode ?? "—"} · {line.qty} × ${line.unitPrice}
                        </td>
                        <td className="num">${line.netAmount}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
                <tfoot>
                  <tr>
                    <td colSpan={4}>
                      {data.total.invoices} document
                      {data.total.invoices === 1 ? "" : "s"}
                      {data.total.revenueCents === selection.figureCents ? (
                        <span className="muted" data-testid="drill-match">
                          {" "}
                          · adds up to the figure
                        </span>
                      ) : (
                        <span className="error" role="alert" data-testid="drill-mismatch">
                          {" "}
                          · does not add up to the figure ({formatUsdCents(selection.figureCents)}); reload the page
                        </span>
                      )}
                    </td>
                    <td className="num" data-testid="drill-total">
                      {formatUsdCents(data.total.revenueCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </DataRegion>
    </section>
  );
}
