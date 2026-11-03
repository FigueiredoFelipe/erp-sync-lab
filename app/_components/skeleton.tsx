// Placeholder shapes for a loading region (PLAN "Loading feedback (R18)"): shapes only, hidden from
// assistive tech, no text and no test id, so a loading shell can never carry a figure.

// Fixed bar heights (percent of the plot) so the placeholder looks the same on every render.
const BAR_HEIGHTS = [46, 62, 54, 71, 58, 80, 66, 74, 60, 52];

// R19: the chart card's legend row is reserved with placeholder swatches (no source names), and the partial
// note's line with a text-height placeholder, so the card has the same height loading and loaded. That holds while
// the loaded card shows a one-line note: the range contains the as-of month (it does: 2026-01..2026-10) and
// `?partial=off` is not set; on a narrow screen where the note wraps, the loaded card is taller.
export function SkeletonChart() {
  return (
    <div className="card" aria-hidden="true">
      <div className="chart-legend">
        {[0, 1].map((index) => (
          <span key={index} className="skeleton-legend-item">
            <span className="skeleton swatch" />
            <span className="skeleton skeleton-legend-name" />
          </span>
        ))}
      </div>
      <div className="chart skeleton-chart">
        {BAR_HEIGHTS.map((height, index) => (
          <span key={index} className="skeleton skeleton-bar" style={{ height: `${height}%` }} />
        ))}
      </div>
      <p className="partial-note">
        <span className="skeleton skeleton-inline skeleton-note" />
      </p>
    </div>
  );
}

// `variant="customers"` (R21, AC41): the Customers table's shape: the reserved mirror/cue row above it, the
// same fixed customer, total and trend columns and the same width, and a footer row like the Total row.
// Other callers keep the plain table.
export function SkeletonTable({
  rows,
  columns,
  heading,
  variant,
}: {
  rows: number;
  columns: number;
  heading?: boolean;
  variant?: "customers";
}) {
  const cells = Array.from({ length: columns }, (_, index) => index);
  if (variant === "customers") {
    const row = (Cell: "th" | "td", key: number) => (
      <tr key={key}>
        {cells.map((cell) => {
          const line = <span className="skeleton skeleton-line" />;
          return cell === 0 && Cell === "td" ? (
            <th key={cell} scope="row">
              {line}
            </th>
          ) : (
            <Cell key={cell}>{line}</Cell>
          );
        })}
      </tr>
    );
    return (
      <div className="card customers-card" aria-hidden="true">
        <div className="table-scroll-frame">
          <div className="table-scroll-bar" data-overflow="false" />
          <div className="table-scroller">
            <table className="customers-table skeleton-table">
              <thead>{row("th", 0)}</thead>
              <tbody>{Array.from({ length: rows }, (_, index) => row("td", index))}</tbody>
              <tfoot>
                <tr>
                  {cells.map((cell) => (
                    <td key={cell}>
                      <span className="skeleton skeleton-line" />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="card" aria-hidden="true">
      {heading && <span className="skeleton skeleton-heading" />}
      <table className="skeleton-table">
        <thead>
          <tr>
            {cells.map((cell) => (
              <th key={cell}>
                <span className="skeleton skeleton-line skeleton-line-short" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, row) => (
            <tr key={row}>
              {cells.map((cell) => (
                <td key={cell}>
                  <span className="skeleton skeleton-line" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card">
          <span className="skeleton skeleton-line skeleton-line-short" />
          <span className="skeleton skeleton-value" />
        </div>
      ))}
    </div>
  );
}

// Busy mark for a control (Apply, Reset, a filter row): reserves its width always, so the control never
// changes size; the spinner shows only while active. Hidden from assistive tech: the control's aria-busy and
// the region's status message say what is loading.
export function BusyMark({ active }: { active: boolean }) {
  return (
    <span className="busy-mark" aria-hidden="true">
      {active && <span className="spinner" />}
    </span>
  );
}
