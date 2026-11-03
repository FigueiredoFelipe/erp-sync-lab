// Seeds the ERPNext lab instance with items, customers and sales invoices.
// Tooling outside the system (see specs/PLAN.md): it calls the ERP directly instead of going through the adapter.
// Idempotent: masters are matched by name, invoices by the deterministic reference stored in po_no.
import { ErpNextClient, ErpNextError } from "./erpnext-client.ts";
import { buildSeedPlan, SEED_PREFIX } from "./data.ts";
import type { PlannedInvoice, SeedPlan } from "./data.ts";

const ERP = {
  company: "Harvest Table Foods",
  currency: "USD",
  customerGroup: "Commercial",
  territory: "United States",
  itemGroup: "Products",
  uom: "Nos",
  sellingPriceList: "Standard Selling",
  receivableAccount: "Debtors - HTF",
  incomeAccount: "Sales - HTF",
  costCenter: "Main - HTF",
} as const;

const PAYMENT_TERM_DAYS = 30;
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type Counts = { created: number; skipped: number };
type InvoiceRow = { name: string; po_no: string; customer: string; grand_total: number; docstatus: number };

async function main(): Promise<void> {
  const plan = buildSeedPlan();

  if (process.argv.includes("--dry-run")) {
    printPlan(plan);
    return;
  }

  const erp = new ErpNextClient(requireEnv("ERPNEXT_URL"), requireEnv("ERPNEXT_API_KEY"), requireEnv("ERPNEXT_API_SECRET"));

  await preflight(erp);
  const items = await seedItems(erp, plan);
  const customers = await seedCustomers(erp, plan);
  const invoices = await seedInvoices(erp, plan);
  await printSummary(erp, items, customers, invoices);
}

async function preflight(erp: ErpNextClient): Promise<void> {
  console.log("Checking ERPNext masters...");
  const required: [doctype: string, name: string][] = [
    ["Company", ERP.company],
    ["Customer Group", ERP.customerGroup],
    ["Territory", ERP.territory],
    ["Item Group", ERP.itemGroup],
    ["UOM", ERP.uom],
    ["Price List", ERP.sellingPriceList],
    ["Account", ERP.receivableAccount],
    ["Account", ERP.incomeAccount],
    ["Cost Center", ERP.costCenter],
  ];
  const missing: string[] = [];
  for (const [doctype, name] of required) {
    if ((await erp.getDoc(doctype, name)) === undefined) missing.push(`${doctype} "${name}"`);
  }
  if (missing.length > 0) throw new Error(`Missing ERPNext masters, nothing was created: ${missing.join(", ")}`);
}

async function seedItems(erp: ErpNextClient, plan: SeedPlan): Promise<Counts> {
  console.log("\nItems");
  const codes = plan.items.map((item) => item.code);
  const existing = new Set((await erp.listAll<{ name: string }>("Item", ["name"], [["name", "in", codes]])).map((r) => r.name));
  const counts: Counts = { created: 0, skipped: 0 };

  for (const item of plan.items) {
    if (existing.has(item.code)) {
      counts.skipped++;
      continue;
    }
    await erp.createDoc("Item", {
      item_code: item.code,
      item_name: item.name,
      description: item.name,
      item_group: ERP.itemGroup,
      stock_uom: ERP.uom,
      is_stock_item: 0,
      include_item_in_manufacturing: 0,
    });
    counts.created++;
    console.log(`  + ${item.code}`);
  }
  return counts;
}

async function seedCustomers(erp: ErpNextClient, plan: SeedPlan): Promise<Counts> {
  console.log("\nCustomers");
  const names = plan.customers.map((customer) => customer.name);
  const existing = new Set((await erp.listAll<{ name: string }>("Customer", ["name"], [["name", "in", names]])).map((r) => r.name));
  const counts: Counts = { created: 0, skipped: 0 };

  for (const customer of plan.customers) {
    if (existing.has(customer.name)) {
      counts.skipped++;
      continue;
    }
    const created = await erp.createDoc<{ name: string }>("Customer", {
      customer_name: customer.name,
      customer_type: "Company",
      customer_group: ERP.customerGroup,
      territory: ERP.territory,
    });
    // Idempotency and invoice links rely on name == customer_name (Selling Settings: naming by Customer Name).
    if (created.name !== customer.name) {
      throw new Error(`Customer "${customer.name}" was saved as "${created.name}"; check Selling Settings > Customer Naming By`);
    }
    counts.created++;
    console.log(`  + ${customer.name}`);
  }
  return counts;
}

async function seedInvoices(erp: ErpNextClient, plan: SeedPlan): Promise<Counts> {
  console.log("\nSales invoices");
  const existing = new Set((await listSeedInvoices(erp)).map((row) => row.po_no));
  const counts: Counts = { created: 0, skipped: 0 };

  for (const invoice of plan.invoices) {
    if (existing.has(invoice.ref)) {
      counts.skipped++;
      continue;
    }
    const created = await erp.createDoc<InvoiceRow>("Sales Invoice", toSalesInvoice(invoice), async () => {
      const [found] = await listSeedInvoices(erp, invoice.ref);
      return found;
    });
    // Totals are deterministic: if ERPNext computed something else (price list, taxes), stop instead of seeding wrong data.
    if (Math.abs(created.grand_total - invoice.total) > 0.005) {
      throw new Error(`${invoice.ref} (${created.name}): expected grand_total ${invoice.total}, ERPNext computed ${created.grand_total}`);
    }
    counts.created++;
    const status = created.docstatus === 1 ? "submitted" : "draft";
    console.log(`  + ${invoice.ref} -> ${created.name} ${status} ${usd.format(created.grand_total)}`);
  }
  return counts;
}

function toSalesInvoice(invoice: PlannedInvoice): object {
  return {
    company: ERP.company,
    customer: invoice.customerName,
    posting_date: invoice.postingDate,
    set_posting_time: 1,
    due_date: addDays(invoice.postingDate, PAYMENT_TERM_DAYS),
    currency: ERP.currency,
    conversion_rate: 1,
    selling_price_list: ERP.sellingPriceList,
    price_list_currency: ERP.currency,
    plc_conversion_rate: 1,
    debit_to: ERP.receivableAccount,
    update_stock: 0,
    po_no: invoice.ref,
    // docstatus 1 on insert makes Frappe run the submit path (validate, before_submit, on_submit).
    docstatus: invoice.docstatus,
    items: invoice.lines.map((line) => ({
      item_code: line.itemCode,
      qty: line.qty,
      rate: line.rate,
      uom: ERP.uom,
      conversion_factor: 1,
      income_account: ERP.incomeAccount,
      cost_center: ERP.costCenter,
    })),
  };
}

function listSeedInvoices(erp: ErpNextClient, ref?: string): Promise<InvoiceRow[]> {
  return erp.listAll<InvoiceRow>(
    "Sales Invoice",
    ["name", "po_no", "customer", "grand_total", "docstatus"],
    [ref ? ["po_no", "=", ref] : ["po_no", "like", `${SEED_PREFIX}-%`]],
  );
}

async function printSummary(erp: ErpNextClient, items: Counts, customers: Counts, invoices: Counts): Promise<void> {
  const rows = await listSeedInvoices(erp);
  const submitted = rows.filter((row) => row.docstatus === 1);
  const drafts = rows.filter((row) => row.docstatus === 0);

  console.log("\nSummary");
  console.log(`  Items:     ${items.created} created, ${items.skipped} skipped`);
  console.log(`  Customers: ${customers.created} created, ${customers.skipped} skipped`);
  console.log(`  Invoices:  ${invoices.created} created, ${invoices.skipped} skipped`);
  console.log(`  In ERPNext now: ${submitted.length} submitted, ${drafts.length} drafts (prefix ${SEED_PREFIX}-)`);

  const byCustomer = new Map<string, { total: number; count: number }>();
  for (const row of submitted) {
    const entry = byCustomer.get(row.customer) ?? { total: 0, count: 0 };
    entry.total += row.grand_total;
    entry.count++;
    byCustomer.set(row.customer, entry);
  }

  console.log("\nSubmitted totals by customer (drafts excluded)");
  const sorted = [...byCustomer].sort((a, b) => b[1].total - a[1].total);
  const width = Math.max(...sorted.map(([name]) => name.length));
  for (const [name, { total, count }] of sorted) {
    console.log(`  ${name.padEnd(width)}  ${String(count).padStart(3)} inv  ${usd.format(total).padStart(13)}`);
  }
  const grandTotal = submitted.reduce((sum, row) => sum + row.grand_total, 0);
  console.log(`  ${"TOTAL".padEnd(width)}  ${String(submitted.length).padStart(3)} inv  ${usd.format(grandTotal).padStart(13)}`);
}

function printPlan(plan: SeedPlan): void {
  const submitted = plan.invoices.filter((inv) => inv.docstatus === 1);
  const lineCount = submitted.reduce((sum, inv) => sum + inv.lines.length, 0);
  console.log(`Dry run (no ERP calls): ${plan.items.length} items, ${plan.customers.length} customers,`);
  console.log(`${submitted.length} submitted invoices (${lineCount} lines), ${plan.invoices.length - submitted.length} drafts.\n`);

  const months = Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
  const width = Math.max(...plan.customers.map((c) => c.name.length));
  console.log(`Planned spend per month, USD thousands\n${"".padEnd(width + 12)}${months.map((m) => m.slice(5).padStart(6)).join("")}`);
  for (const customer of plan.customers) {
    const cells = months.map((month) => {
      const total = submitted
        .filter((inv) => inv.customerCode === customer.code && inv.postingDate.startsWith(month))
        .reduce((sum, inv) => sum + inv.total, 0);
      return (total === 0 ? "-" : (total / 1000).toFixed(1)).padStart(6);
    });
    console.log(`${customer.name.padEnd(width)}  ${customer.pattern.kind.padEnd(10)}${cells.join("")}`);
  }

  const sample = plan.invoices[0];
  if (sample) console.log(`\nSample invoice body:\n${JSON.stringify(toSalesInvoice(sample), null, 2)}`);
  console.log(`\nDrafts: ${plan.invoices.filter((inv) => inv.docstatus === 0).map((inv) => inv.ref).join(", ")}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

main().catch((error: unknown) => {
  const message = error instanceof ErpNextError || error instanceof Error ? error.message : String(error);
  console.error(`\nSeed stopped: ${message}`);
  process.exitCode = 1;
});
