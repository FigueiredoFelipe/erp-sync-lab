import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T17/T23: public.revenue_document and public.customer_monthly_revenue on the LOCAL stack.
// The migration is applied inside a transaction that is rolled back, so the shared db is untouched.
const MIGRATION = readFileSync(
  join(__dirname, "..", "..", "supabase", "migrations", "20261018230000_customer_revenue.sql"),
  "utf8",
);

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  // Load the migration only where it isn't applied yet (the shared local DB may already have it).
  const { rows } = await client.query<{ present: boolean }>("select to_regclass('public.customer_monthly_revenue') is not null as present");
  if (!rows[0]?.present) await client.query(MIGRATION);
});

afterEach(async () => {
  await client.query("rollback");
});

// Year 2031 keeps these rows apart from whatever the shared db holds.
const SETUP = `
  insert into public.customer (canonical_id, display_name) values ('t17-acme', 'T17 Acme Foods Inc.')
    on conflict (canonical_id) do nothing;
  insert into public.invoice
    (source, source_doc_id, source_customer, canonical_customer_id, invoice_date, currency, amount, is_credit_note,
     source_version, mapping_version, candidate, raw_ref, updated_at)
  values
    ('erpnext', 'T17-A1', 'T17 Acme', 't17-acme', '2031-03-31', 'USD', 1000.10, false, 'v1', 1, '{}', 'r', '2031-05-01'),
    ('legacy_unit_b', 'T17-B1', 'T17 ACME FOODS', 't17-acme', '2031-03-02', 'USD', 200.05, false, 'v1', 1, '{}', 'r', '2031-03-02'),
    -- A credit note posted in April against a March invoice, modified in May: it counts in April, negative.
    ('erpnext', 'T17-A2', 'T17 Acme', 't17-acme', '2031-04-01', 'USD', -150.00, true, 'v1', 1, '{}', 'r', '2031-05-02'),
    -- Not mapped yet: keyed by source + source customer, labelled with the source's name.
    ('erpnext', 'T17-U1', 'T17 Mystery Diner', null, '2031-03-15', 'USD', 42.00, false, 'v1', 0, '{}', 'r', '2031-03-15'),
    ('legacy_unit_b', 'T17-U2', 'T17 Mystery Diner', null, '2031-03-16', 'USD', 8.00, false, 'v1', 0, '{}', 'r', '2031-03-16');
`;

type Row = { month: string; source: string; customer_key: string; customer_name: string; mapped: boolean; revenue: string; invoices: number };

async function viewRows(): Promise<Row[]> {
  const result = await client.query<Row>(
    `select to_char(month, 'YYYY-MM') as month, source, customer_key, customer_name, mapped, revenue::text, invoices
     from public.customer_monthly_revenue where month >= '2031-01-01' and month < '2032-01-01'
     order by customer_key, month, source`,
  );
  return result.rows;
}

describe("public.customer_monthly_revenue (BR07)", () => {
  it("groups by the invoice-date month, per customer and source, credit notes negative in their own month", async () => {
    await client.query(SETUP);
    await client.query("set local role service_role");
    expect(await viewRows()).toEqual([
      { month: "2031-03", source: "erpnext", customer_key: "t17-acme", customer_name: "T17 Acme Foods Inc.", mapped: true, revenue: "1000.10", invoices: 1 },
      { month: "2031-03", source: "legacy_unit_b", customer_key: "t17-acme", customer_name: "T17 Acme Foods Inc.", mapped: true, revenue: "200.05", invoices: 1 },
      { month: "2031-04", source: "erpnext", customer_key: "t17-acme", customer_name: "T17 Acme Foods Inc.", mapped: true, revenue: "-150.00", invoices: 1 },
      { month: "2031-03", source: "erpnext", customer_key: "unmapped:erpnext:T17 Mystery Diner", customer_name: "T17 Mystery Diner", mapped: false, revenue: "42.00", invoices: 1 },
      { month: "2031-03", source: "legacy_unit_b", customer_key: "unmapped:legacy_unit_b:T17 Mystery Diner", customer_name: "T17 Mystery Diner", mapped: false, revenue: "8.00", invoices: 1 },
    ]);
  });

  it("AC18: each customer's revenue equals its valid Source A plus valid Source B invoices, over the canonical tables", async () => {
    await client.query(SETUP);
    // Compares the whole view with a direct query over invoice, for every customer in the db (seeded data included).
    const diff = await client.query(
      `with v as (
         select customer_key, sum(revenue) as revenue from public.customer_monthly_revenue group by 1
       ), d as (
         select coalesce(canonical_customer_id, 'unmapped:' || source || ':' || source_customer) as customer_key,
                sum(amount) filter (where source = 'erpnext') as source_a,
                sum(amount) filter (where source = 'legacy_unit_b') as source_b
         from public.invoice group by 1
       )
       select coalesce(v.customer_key, d.customer_key) as customer_key
       from v full join d on d.customer_key = v.customer_key
       where v.revenue is distinct from coalesce(d.source_a, 0) + coalesce(d.source_b, 0)`,
    );
    expect(diff.rows).toEqual([]);
    const acme = await client.query<{ revenue: string }>(
      "select sum(revenue)::text as revenue from public.customer_monthly_revenue where customer_key = 't17-acme'",
    );
    expect(acme.rows[0]?.revenue).toBe("1050.15");
  });

  it("totals the same as public.monthly_revenue for every month", async () => {
    await client.query(SETUP);
    const diff = await client.query(
      `select coalesce(c.month, m.month) as month
       from (select month, sum(revenue) as revenue from public.customer_monthly_revenue group by 1) c
       full join (select month, sum(revenue) as revenue from public.monthly_revenue group by 1) m on m.month = c.month
       where c.revenue is distinct from m.revenue`,
    );
    expect(diff.rows).toEqual([]);
  });
});

describe("public.revenue_document (R12, AC12)", () => {
  it("lists documents whose amounts add up to the customer-month figure", async () => {
    await client.query(SETUP);
    await client.query("set local role service_role");
    const docs = await client.query<{ source_doc_id: string; amount: string }>(
      `select source_doc_id, amount::text from public.revenue_document
       where customer_key = 't17-acme' and month = '2031-03-01' order by source_doc_id`,
    );
    expect(docs.rows).toEqual([
      { source_doc_id: "T17-A1", amount: "1000.10" },
      { source_doc_id: "T17-B1", amount: "200.05" },
    ]);
    const figure = await client.query<{ revenue: string }>(
      `select sum(revenue)::text as revenue from public.customer_monthly_revenue where customer_key = 't17-acme' and month = '2031-03-01'`,
    );
    expect(figure.rows[0]?.revenue).toBe("1200.15");
  });

  it("AC12: for every customer-month in the db, the documents add up to the figure", async () => {
    await client.query(SETUP);
    const diff = await client.query(
      `select f.customer_key, f.month
       from (select customer_key, month, sum(revenue) as revenue from public.customer_monthly_revenue group by 1, 2) f
       left join (select customer_key, month, sum(amount) as amount from public.revenue_document group by 1, 2) d
         on d.customer_key = f.customer_key and d.month = f.month
       where f.revenue is distinct from d.amount`,
    );
    expect(diff.rows).toEqual([]);
  });
});

describe("grants and security_invoker", () => {
  it.each(["public.customer_monthly_revenue", "public.revenue_document"])("anon cannot read %s", async (view) => {
    await client.query("set local role anon");
    expect(await sqlState(client, `select * from ${view}`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // T22: authenticated may select, but RLS on invoice hides every row unless the caller is allowlisted.
  it.each(["public.customer_monthly_revenue", "public.revenue_document"])(
    "%s shows no rows to an authenticated user who is not allowlisted",
    async (view) => {
      await client.query(SETUP);
      await client.query("set local role authenticated");
      expect((await client.query(`select * from ${view}`)).rows).toEqual([]);
    },
  );

  it.each(["public.customer_monthly_revenue", "public.revenue_document"])("%s runs with the caller's privileges", async (view) => {
    const result = await client.query<{ reloptions: string[] | null }>(`select reloptions from pg_class where oid = '${view}'::regclass`);
    expect(result.rows[0]?.reloptions).toContain("security_invoker=true");
  });
});
