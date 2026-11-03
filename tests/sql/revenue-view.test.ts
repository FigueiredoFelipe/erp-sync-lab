import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { connect, inRolledBackTx, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T10: public.monthly_revenue and public.app_test_switch on the LOCAL stack. Every check is rolled back.
let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

const INSERT_INVOICES = `
  insert into public.invoice
    (source, source_doc_id, source_customer, invoice_date, currency, amount, source_version, mapping_version, candidate, raw_ref)
  values
    ('erpnext', 'T10-A', 'C1', '2031-01-05', 'USD', 100.10, 'v1', 0, '{}', 'r'),
    ('erpnext', 'T10-B', 'C1', '2031-01-31', 'USD', 0.20, 'v1', 0, '{}', 'r'),
    ('legacy_unit_b', 'T10-C', 'C2', '2031-01-15', 'USD', 5.00, 'v1', 0, '{}', 'r'),
    ('erpnext', 'T10-D', 'C1', '2031-02-01', 'USD', -40.00, 'v1', 0, '{}', 'r')`;

describe("public.monthly_revenue", () => {
  it("sums invoice.amount per month and source", async () => {
    const rows = await inRolledBackTx(client, async () => {
      await client.query(INSERT_INVOICES);
      await client.query("set local role service_role");
      const result = await client.query<{ month: string; source: string; revenue: string; invoices: number }>(
        `select to_char(month, 'YYYY-MM-DD') as month, source, revenue::text, invoices
         from public.monthly_revenue where month >= '2031-01-01' order by month, source`,
      );
      return result.rows;
    });
    expect(rows).toEqual([
      { month: "2031-01-01", source: "erpnext", revenue: "100.30", invoices: 2 },
      { month: "2031-01-01", source: "legacy_unit_b", revenue: "5.00", invoices: 1 },
      { month: "2031-02-01", source: "erpnext", revenue: "-40.00", invoices: 1 },
    ]);
  });

  it("matches the direct query over invoice for every month", async () => {
    const diff = await client.query(
      `select coalesce(v.month, d.month) as month
       from (select month, sum(revenue) as revenue from public.monthly_revenue group by 1) v
       full join (select date_trunc('month', invoice_date)::date as month, sum(amount) as revenue
                  from public.invoice group by 1) d on d.month = v.month
       where v.revenue is distinct from d.revenue`,
    );
    expect(diff.rows).toEqual([]);
  });

  it("is not readable by anon", async () => {
    const state = await inRolledBackTx(client, async () => {
      await client.query("set local role anon");
      return sqlState(client, "select * from public.monthly_revenue");
    });
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // T22: authenticated may select, but RLS on invoice hides every row unless the caller is allowlisted.
  it("shows no rows to an authenticated user who is not allowlisted", async () => {
    const { before, rows } = await inRolledBackTx(client, async () => {
      await client.query(INSERT_INVOICES);
      // The fixtures are visible to a role that bypasses RLS, so the empty result below isn't vacuous.
      const before = (await client.query("select * from public.monthly_revenue where month >= '2031-01-01' and month < '2032-01-01'")).rows;
      await client.query("set local role authenticated");
      return { before, rows: (await client.query("select * from public.monthly_revenue")).rows };
    });
    expect(before.length).toBeGreaterThan(0);
    expect(rows).toEqual([]);
  });

  it("runs with the caller's privileges (security_invoker)", async () => {
    const result = await client.query<{ reloptions: string[] | null }>(
      "select reloptions from pg_class where oid = 'public.monthly_revenue'::regclass",
    );
    expect(result.rows[0]?.reloptions).toContain("security_invoker=true");
  });
});

describe("public.app_test_switch", () => {
  async function switchAs(role: string, setup?: string): Promise<boolean> {
    return inRolledBackTx(client, async () => {
      if (setup) await client.query(setup);
      await client.query(`set local role ${role}`);
      const result = await client.query<{ on: boolean }>("select public.app_test_switch('t10_probe') as on");
      return result.rows[0]?.on ?? false;
    });
  }

  it("is off when the row is missing, on when it exists and is enabled", async () => {
    expect(await switchAs("service_role")).toBe(false);
    expect(await switchAs("service_role", "insert into internal.test_switch (name, enabled) values ('t10_probe', true)")).toBe(true);
    expect(await switchAs("service_role", "insert into internal.test_switch (name, enabled) values ('t10_probe', false)")).toBe(false);
  });

  it("cannot be executed by anon", async () => {
    const state = await inRolledBackTx(client, async () => {
      await client.query("set local role anon");
      return sqlState(client, "select public.app_test_switch('t10_probe')");
    });
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // T22: authenticated may execute it, but it is always off unless the caller is allowlisted.
  it("is off for an authenticated user who is not allowlisted, even when enabled", async () => {
    expect(await switchAs("authenticated", "insert into internal.test_switch (name, enabled) values ('t10_probe', true)")).toBe(false);
  });
});
