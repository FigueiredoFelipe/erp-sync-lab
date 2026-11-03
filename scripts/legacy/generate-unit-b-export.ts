// Generates the Source B ("Unit B", on-premise, no API) export with planted errors,
// its README of expected quarantine outcomes (AC04), and the seed README of expected trends (AC07).
// Tooling outside the system (see specs/PLAN.md). Deterministic: same code, same files.
import { mkdirSync, writeFileSync } from "node:fs";
import { CUSTOMERS } from "../seed/data.ts";
import {
  buildUnitBExports,
  EXPORT_DATE,
  invoiceCents,
  isValid,
  MONTHS,
  NEWER_EXPORT_DATE,
  OLDER_EXPORT_DATE,
  UNIT_B_CUSTOMERS,
  zeros,
  type Line,
  type Plant,
  type UnitBCustomer,
  type UnitBInvoice,
} from "./unit-b-plan.ts";

const csvPath = (exportDate: string) => `data/unit_b_export_${exportDate}.csv`;
const DATA_README_PATH = "data/legacy_unit_b.README.md";
const SEED_README_PATH = "scripts/seed/README.md";
const HEADER = ["INV_NO", "CUST_NAME", "INV_DATE", "CURRENCY", "LINE_ITEM", "QTY", "UNIT_PRICE", "INV_TOTAL"] as const;

// AC07 fixes the BR08 as-of date at 2026-10-16: complete months are January to September.
const AS_OF_DATE = "2026-10-16";

function main(): void {
  const { erpMonthlyCents, invoices, newerSnapshot, olderSnapshot, removed, removedQuarantined } = buildUnitBExports();

  const files = [
    { exportDate: EXPORT_DATE, invoices },
    { exportDate: NEWER_EXPORT_DATE, invoices: newerSnapshot },
    { exportDate: OLDER_EXPORT_DATE, invoices: olderSnapshot },
  ];
  mkdirSync("data", { recursive: true });
  for (const file of files) {
    writeFileSync(csvPath(file.exportDate), toCsv(file.invoices));
  }

  // The newer snapshot only drops a January invoice, so it must not change any expected trend.
  const trendsNow = expectedTrends(erpMonthlyCents, invoices);
  const trendsAfterNewer = expectedTrends(erpMonthlyCents, newerSnapshot);
  if (JSON.stringify(trendsNow.map((t) => t.label)) !== JSON.stringify(trendsAfterNewer.map((t) => t.label))) {
    throw new Error("The newer snapshot changes an expected trend; pick another invoice to remove");
  }

  writeFileSync(DATA_README_PATH, dataReadme(invoices, removed, removedQuarantined, newerSnapshot, olderSnapshot));
  writeFileSync(SEED_README_PATH, seedReadme(trendsNow));
  for (const file of files) {
    console.log(`Wrote ${csvPath(file.exportDate)} (${file.invoices.length} invoices, ${file.invoices.flatMap(toRows).length} rows)`);
  }
  console.log(`Wrote ${DATA_README_PATH}, ${SEED_README_PATH}`);
}

function toCsv(invoices: UnitBInvoice[]): string {
  const rows = invoices.flatMap(toRows);
  return [HEADER.join(","), ...rows.map((row) => row.map(csvField).join(","))].join("\n") + "\n";
}

function toRows(invoice: UnitBInvoice): string[][] {
  const plant = invoice.plant;
  const linesCents = invoice.lines.map((line) => line.qty * line.item.priceCents);
  const sumCents = linesCents.reduce((sum, c) => sum + c, 0);
  const totalCents = sumCents + (plant?.kind === "total_mismatch" ? plant.deltaCents : 0);
  const customer = plant?.kind === "blank_customer" ? "" : invoice.customer.csvName;
  const date = plant?.kind === "invalid_date" ? plant.value : `${pad(invoice.month)}/${pad(invoice.day)}/2026`;
  const currency = plant?.kind === "currency" ? plant.value : "USD";

  const rows = invoice.lines.map((line, i) => {
    const rowTotal = plant?.kind === "conflicting_total" && i === 1 ? totalCents + plant.deltaCents : totalCents;
    return [invoice.invNo, customer, date, currency, line.item.description, String(line.qty), money(line.item.priceCents), money(rowTotal)];
  });
  if (plant?.kind === "duplicate_row") rows.splice(1, 0, [...(rows[0] as string[])]);
  return rows;
}

// Expected outcome of each planted case under BR02-BR06 (one reason code per invoice).
function expectedReason(plant: Plant): string {
  switch (plant.kind) {
    case "total_mismatch":
      return "`TOTAL_MISMATCH`";
    case "blank_customer":
      return "`MISSING_FIELD`";
    case "invalid_date":
      return "`INVALID_DATE`";
    case "conflicting_total":
      return "`CONFLICTING_DUPLICATE`";
    case "currency":
      return "`UNSUPPORTED_CURRENCY`";
    case "duplicate_row":
      return "valid; the copy is dropped, counts once (AC19)";
    case "real_duplicate_lines":
      return "valid; both rows are real lines and count (AC19)";
  }
}

function plantDescription(invoice: UnitBInvoice, plant: Plant): string {
  const sumCents = invoiceCents(invoice);
  switch (plant.kind) {
    case "total_mismatch":
      return `INV_TOTAL ${money(sumCents + plant.deltaCents)} vs line sum ${money(sumCents)}`;
    case "blank_customer":
      return "CUST_NAME empty on every row";
    case "invalid_date":
      return `INV_DATE "${plant.value}" (no such day)`;
    case "conflicting_total":
      return `row 2 says INV_TOTAL ${money(sumCents + plant.deltaCents)}, the other rows say ${money(sumCents)}`;
    case "currency":
      return `CURRENCY ${plant.value} on every row`;
    case "duplicate_row": {
      const copy = invoice.lines[0] as Line;
      return `row 1 appears twice, identical; INV_TOTAL ${money(sumCents)} matches with the copy counted once (with both: ${money(sumCents + copy.qty * copy.item.priceCents)})`;
    }
    case "real_duplicate_lines": {
      const line = invoice.lines[0] as Line;
      return `row 1 appears twice, identical; INV_TOTAL ${money(sumCents)} matches only with both rows (counted once: ${money(sumCents - line.qty * line.item.priceCents)})`;
    }
  }
}

function validTotalsByCustomer(invoices: UnitBInvoice[]): Map<UnitBCustomer, { count: number; cents: number }> {
  const totals = new Map<UnitBCustomer, { count: number; cents: number }>();
  for (const c of UNIT_B_CUSTOMERS) totals.set(c, { count: 0, cents: 0 });
  for (const inv of invoices.filter(isValid)) {
    const entry = totals.get(inv.customer) as { count: number; cents: number };
    entry.count++;
    entry.cents += invoiceCents(inv);
  }
  return totals;
}

function dataReadme(
  invoices: UnitBInvoice[],
  removed: UnitBInvoice,
  removedQuarantined: UnitBInvoice,
  newer: UnitBInvoice[],
  older: UnitBInvoice[],
): string {
  const planted = invoices.filter((inv) => inv.plant !== undefined);
  const rejected = planted.filter((inv) => !isValid(inv));
  const valid = invoices.filter(isValid);
  const validTotal = valid.reduce((sum, inv) => sum + invoiceCents(inv), 0);
  const rowCount = (list: UnitBInvoice[]) => list.flatMap(toRows).length;
  const missingFromOlder = invoices.filter((inv) => !older.includes(inv));

  const now = validTotalsByCustomer(invoices);
  const afterNewer = validTotalsByCustomer(newer);
  const perCustomer = UNIT_B_CUSTOMERS.map((c) => {
    const a = now.get(c) as { count: number; cents: number };
    const b = afterNewer.get(c) as { count: number; cents: number };
    return `| ${c.csvName} | ${c.canonical} | ${c.kind === "shared" ? "both" : "Unit B only"} | ${a.count} | ${money(a.cents)} | ${money(b.cents)} |`;
  });

  return `# Unit B legacy export (Source B)

Generated by \`npm run legacy:csv\` (\`scripts/legacy/generate-unit-b-export.ts\`). Fictitious data. Do not edit by hand: change the generator and run it again.

## Files

| File | Invoices | Rows | Role |
|---|---:|---:|---|
| \`${csvPath(EXPORT_DATE)}\` | ${invoices.length} | ${rowCount(invoices)} | Main export: planted errors (AC04) and repeated rows (AC19) |
| \`${csvPath(NEWER_EXPORT_DATE)}\` | ${newer.length} | ${rowCount(newer)} | Newer snapshot: the main export without ${removed.invNo} (valid) and ${removedQuarantined.invNo} (quarantined) (AC17) |
| \`${csvPath(OLDER_EXPORT_DATE)}\` | ${older.length} | ${rowCount(older)} | Older snapshot, rejected whole once a newer file is ingested (AC17) |

- The export date comes from the file name (\`unit_b_export_YYYY-MM-DD.csv\`). Under BR10 each file is a full snapshot from 2026-01-01 up to its export date.
- One row per invoice line. Columns: \`${HEADER.join(", ")}\`. \`INV_DATE\` is \`MM/DD/YYYY\`. \`CUST_NAME\`, \`INV_DATE\`, \`CURRENCY\` and \`INV_TOTAL\` repeat on every row of an invoice. \`UNIT_PRICE\` and \`INV_TOTAL\` have 2 decimals.
- The main export has ${valid.length} valid invoices, totalling USD ${money(validTotal)}.
- Line endings are LF. Fields that contain a comma are quoted (\`"Cedar Valley Bakery, Inc."\`); that is correct CSV, not an error.

## Planted cases in the main export (AC04, AC19)

Each case has exactly one expected outcome. All of them sit in January, February, March or October, outside every BR08 trend window (April to September), so AC04, AC19 and AC07 don't interfere.

| INV_NO | Customer as written | What is special | Expected outcome |
|---|---|---|---|
${planted.map((inv) => `| ${inv.invNo} | ${inv.customer.csvName} | ${plantDescription(inv, inv.plant as Plant)} | ${expectedReason(inv.plant as Plant)} |`).join("\n")}

Passing AC04 requires all of the following:

- Each of the ${rejected.length} invoices with a reason code is in quarantine with that one code, source \`legacy_unit_b\`, its \`INV_NO\` and a rejection date.
- None of them counts in the figures.

Passing AC19 requires both of the following:

- ${planted.find((inv) => inv.plant?.kind === "duplicate_row")?.invNo} counts once, at its \`INV_TOTAL\`, and isn't quarantined.
- ${planted.find((inv) => inv.plant?.kind === "real_duplicate_lines")?.invNo} counts both repeated rows, at its \`INV_TOTAL\`.

No row is missing \`INV_NO\`. Q8 was decided on 2026-10-18: such a row is quarantined on its own as \`MISSING_FIELD\` (BR03); the adapter tests cover it with synthetic rows, so the sample files stay unchanged.

## Snapshot sequence (AC17)

Upload the files one at a time, in this order, and wait until each one is ingested. \`legacy-ingest\` takes the oldest new export date first, so uploading them together would ingest the 10-15 file before the 10-16 one.

1. **\`${csvPath(EXPORT_DATE)}\`:** the baseline. Expect the outcomes above.
2. **\`${csvPath(NEWER_EXPORT_DATE)}\`:** identical except that two invoices are missing:
   - ${removed.invNo} (${removed.customer.csvName}, ${pad(removed.month)}/${pad(removed.day)}/2026, USD ${money(invoiceCents(removed))}, valid) leaves the figures, and ${removed.customer.canonical}'s Unit B total drops by USD ${money(invoiceCents(removed))}.
   - ${removedQuarantined.invNo} (${removedQuarantined.customer.csvName}, in quarantine as \`INVALID_DATE\`) gets its quarantine entry closed, with resolution \`removed_from_export\`. It was never in the figures, so no total changes.
   - Every other invoice and every other quarantine entry stays as it was.
   - Both removed invoices are outside April to September, so no expected trend changes (the generator checks this).
3. **\`${csvPath(OLDER_EXPORT_DATE)}\`:** its export date is older than the newest ingested one (2026-10-17), so the whole file is rejected and nothing changes.
   - It is a real older snapshot: it lacks the ${missingFromOlder.length} invoices dated 10/15/2026 (${missingFromOlder.map((inv) => inv.invNo).join(", ")}).
   - If it were wrongly accepted, those invoices would leave the figures or the quarantine, which makes the failure visible.

## Customers (BR05) and expected Unit B totals (AC18)

The spelling differences are deliberate. Under BR05 the customer mapping decides every match, including Unit B only customers, and normalization never decides on its own. This table is the intended mapping content for Unit B.

| As written in the CSV | Canonical customer | In | Valid invoices (10-16) | Valid total after 10-16 (USD) | After 10-17 (USD) |
|---|---|---|---:|---:|---:|
${perCustomer.join("\n")}

For AC18, each customer's dashboard revenue is their seeded ERPNext total (\`scripts/seed/README.md\`, \`npm run seed:erp:dry\`) plus the Unit B total in the column for the newest ingested file.

\`REDWOOD  PIZZA KITCHEN\` differs from the ERPNext name only in case and spacing. Normalization makes the two names equal, but the alias still has to be in the mapping.
`;
}

type ExpectedTrend = { name: string; seedPattern: string; prev3: number; last3: number; label: string };

function expectedTrends(erp: Map<string, number[]>, unitB: UnitBInvoice[]): ExpectedTrend[] {
  const combined = new Map<string, number[]>();
  for (const c of CUSTOMERS) combined.set(c.name, [...(erp.get(c.name) ?? zeros())]);
  for (const c of UNIT_B_CUSTOMERS) if (!combined.has(c.canonical)) combined.set(c.canonical, zeros());
  for (const inv of unitB.filter(isValid)) {
    (combined.get(inv.customer.canonical) as number[])[inv.month - 1]! += invoiceCents(inv);
  }

  return [...combined].map(([name, monthly]) => {
    const result = trend(monthly, AS_OF_DATE);
    return {
      name,
      seedPattern: CUSTOMERS.find((c) => c.name === name)?.pattern.kind ?? "(Unit B only)",
      prev3: result.prev3,
      last3: result.last3,
      label: result.label,
    };
  });
}

function seedReadme(trends: ExpectedTrend[]): string {
  const rows = trends.map((t) => {
    const change = t.prev3 <= 0 ? "—" : `${(((t.last3 - t.prev3) / t.prev3) * 100).toFixed(2)}%`;
    return `| ${t.name} | ${t.seedPattern} | ${money(t.prev3)} | ${money(t.last3)} | ${change} | **${t.label}** |`;
  });

  return `# ERPNext seed

\`npm run seed:erp\` creates, through the ERPNext REST API, 8 non-stock items, 15 customers, 196 submitted Sales Invoices (January to October 15, 2026) and 4 drafts. It is idempotent: masters are matched by name, and invoices by the deterministic reference \`SEED-<CUSTOMER>-<YYYY-MM>-<n>\` stored in \`po_no\`. \`npm run seed:erp:dry\` prints the plan without calling the ERP.

It is a tool outside the system (see \`specs/PLAN.md\`, "Ferramentas fora do sistema").

## Expected trends (AC07)

**Valid for the as-of date ${AS_OF_DATE}**, which AC07 fixes for the test. The complete months are January to September, the previous 3 are April to June, and the last 3 are July to September.

- Computed with BR08 version 4 on both sources combined: the seeded ERPNext invoices plus the valid invoices of \`${csvPath(EXPORT_DATE)}\`, mapped to their canonical customers as listed in \`data/legacy_unit_b.README.md\`.
- Amounts are compared exactly, in cents.
- Ingesting \`${csvPath(NEWER_EXPORT_DATE)}\` afterwards changes no row of this table; the generator checks that.
- Generated by \`npm run legacy:csv\`; don't edit by hand.

| Customer | Seed pattern | Apr–Jun (USD) | Jul–Sep (USD) | Change | Expected trend |
|---|---|---:|---:|---:|---|
${rows.join("\n")}
`;
}

// BR08 version 4 on monthly cents (index 0 = January 2026), whole stored history.
function trend(monthly: number[], asOfDate: string): { label: string; prev3: number; last3: number } {
  const revenue = (month: number) => monthly[month - 1] ?? 0;
  // A month is complete when its last day is before the as-of date.
  const complete = range(1, monthly.length).filter((month) => lastDayOf(month) < asOfDate);
  const last = complete[complete.length - 1] as number;
  const prev3 = sumMonths(monthly, last - 5, last - 3);
  const last3 = sumMonths(monthly, last - 2, last);

  const hasRevenue = (month: number) => revenue(month) > 0;
  const firstWithRevenue = range(1, monthly.length).find(hasRevenue);
  const churned = complete.some((month) => month < last - 1 && hasRevenue(month)) && !hasRevenue(last - 1) && !hasRevenue(last);

  const label = churned
    ? "churned"
    : firstWithRevenue !== undefined && firstWithRevenue >= last - 2 && firstWithRevenue <= last
      ? "new"
      : prev3 <= 0
        ? last3 > 0 ? "growing" : "stable"
        : last3 * 100 > prev3 * 115
          ? "growing"
          : last3 * 100 < prev3 * 85
            ? "declining"
            : "stable";
  return { label, prev3, last3 };
}

function lastDayOf(month: number): string {
  const date = new Date(Date.UTC(2026, month, 0));
  return date.toISOString().slice(0, 10);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function sumMonths(monthly: number[], from: number, to: number): number {
  let sum = 0;
  for (let month = from; month <= to; month++) sum += monthly[month - 1] ?? 0;
  return sum;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

main();
