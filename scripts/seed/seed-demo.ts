// Ensures exactly one submitted DEMO invoice exists in the ERPNext instance: cancelling it in ERPNext makes
// the dashboard's October drop by exactly USD 1,000.00, which shows the cancel path end to end.
// Tooling outside the system, like the seed (see specs/PLAN.md "Tools outside the system"): it calls
// the ERP directly instead of going through the adapter, and never touches the SEED- invoices.
//
// Idempotent: if a submitted (docstatus 1) invoice with po_no DEMO-% exists, it prints it and stops.
// Cancelled DEMO invoices (docstatus 2) are ignored, so after the demo the next run creates a fresh one.
// The invoice is created as a draft, its total checked, and only then submitted (fail-closed).
import { ErpNextClient, ErpNextError } from "./erpnext-client.ts";

const DEMO_PREFIX = "DEMO";
const DEMO = {
  company: "Harvest Table Foods",
  customer: "Union Station Eatery",
  currency: "USD",
  sellingPriceList: "Standard Selling",
  receivableAccount: "Debtors - HTF",
  incomeAccount: "Sales - HTF",
  costCenter: "Main - HTF",
  uom: "Nos",
  // An existing seed item with a custom rate: 40 x 25.00 = 1,000.00.
  itemCode: "FLOUR-AP-50LB",
  qty: 40,
  rate: 25,
  expectedTotal: 1000,
  // ERPNext runs on New York local time; "today" and the po_no timestamp follow it.
  timeZone: "America/New_York",
} as const;

type InvoiceRow = { name: string; po_no: string; customer: string; posting_date: string; grand_total: number; docstatus: number };

const FIELDS = ["name", "po_no", "customer", "posting_date", "grand_total", "docstatus"];
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const erp = new ErpNextClient(requireEnv("ERPNEXT_URL"), requireEnv("ERPNEXT_API_KEY"), requireEnv("ERPNEXT_API_SECRET"));

  const submitted = await erp.listAll<InvoiceRow>("Sales Invoice", FIELDS, [
    ["company", "=", DEMO.company],
    ["po_no", "like", `${DEMO_PREFIX}-%`],
    ["docstatus", "=", 1],
  ]);
  if (submitted.length > 1) {
    // More than one would make scene (a) ambiguous; a human decides which to cancel.
    for (const row of submitted) print("Submitted DEMO invoice", row);
    throw new Error(`${submitted.length} submitted DEMO invoices exist; cancel the extras in ERPNext and run again`);
  }
  const [existing] = submitted;
  if (existing) {
    print("Already exists, nothing created", existing);
    return;
  }

  const now = localParts(new Date(), DEMO.timeZone);
  const poNo = `${DEMO_PREFIX}-${now.compactDate}-${now.compactTime}`;
  const findByPoNo = async () => (await erp.listAll<InvoiceRow>("Sales Invoice", FIELDS, [["po_no", "=", poNo]]))[0];

  const draft = await erp.createDoc<InvoiceRow>(
    "Sales Invoice",
    {
      company: DEMO.company,
      customer: DEMO.customer,
      posting_date: now.isoDate,
      set_posting_time: 1,
      due_date: now.isoDate,
      currency: DEMO.currency,
      conversion_rate: 1,
      selling_price_list: DEMO.sellingPriceList,
      price_list_currency: DEMO.currency,
      plc_conversion_rate: 1,
      debit_to: DEMO.receivableAccount,
      update_stock: 0,
      po_no: poNo,
      docstatus: 0,
      items: [
        {
          item_code: DEMO.itemCode,
          qty: DEMO.qty,
          rate: DEMO.rate,
          uom: DEMO.uom,
          conversion_factor: 1,
          income_account: DEMO.incomeAccount,
          cost_center: DEMO.costCenter,
        },
      ],
    },
    findByPoNo,
  );

  // A draft never reaches the dashboard, so stopping here leaves nothing wrong behind.
  if (Math.abs(draft.grand_total - DEMO.expectedTotal) > 0.005) {
    throw new Error(`${draft.name} (draft) totals ${draft.grand_total}, expected ${DEMO.expectedTotal}; left as a draft, not submitted`);
  }

  // Saving with docstatus 1 runs Frappe's submit path (0 -> 1).
  const path = `/api/resource/Sales%20Invoice/${encodeURIComponent(draft.name)}`;
  const res = await erp.request<{ data: InvoiceRow }>("PUT", path, { body: { docstatus: 1 } });
  if (res.data.docstatus !== 1) throw new Error(`${draft.name} was not submitted (docstatus ${res.data.docstatus})`);
  print("Created and submitted", res.data);
}

function print(label: string, row: InvoiceRow): void {
  console.log(`${label}: ${row.name}  po_no ${row.po_no}  total ${usd.format(row.grand_total)}`);
}

function localParts(date: Date, timeZone: string): { isoDate: string; compactDate: string; compactTime: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const isoDate = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  return {
    isoDate,
    compactDate: isoDate.replaceAll("-", ""),
    compactTime: `${parts["hour"]}${parts["minute"]}${parts["second"]}`,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof ErpNextError || error instanceof Error ? error.message : String(error);
  console.error(`\nseed:demo stopped: ${message}`);
  process.exitCode = 1;
});
