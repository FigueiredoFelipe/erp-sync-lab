import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { connect, inRolledBackTx, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T2, updated in T22: anon reaches no table, no internal function and no queue. authenticated may SELECT the
// public tables (RLS then shows rows only to allowlisted users, see auth-allowlist.test.ts) and has USAGE on
// internal for the allowlist check; every write, internal table, other internal function and queue stays
// denied (PLAN "Dashboard, API and access"). Every check runs in a transaction that is rolled back.
const API_ROLES = ["anon", "authenticated"] as const;

let client: pg.Client;
let publicTables: { name: string; firstColumn: string }[];
let internalTables: string[];

beforeAll(async () => {
  client = await connect();
  const pub = await client.query<{ name: string; first_column: string }>(
    `select c.relname as name,
            (select a.attname from pg_attribute a
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             order by a.attnum limit 1) as first_column
     from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
     order by c.relname`,
  );
  publicTables = pub.rows.map((row) => ({ name: row.name, firstColumn: row.first_column }));
  const internal = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'internal' order by tablename",
  );
  internalTables = internal.rows.map((row) => row.tablename);
});

afterAll(async () => {
  await client.end();
});

// SQLSTATE of `sql` run as `role`, after optional setup run as postgres.
async function stateAs(role: string, sql: string, setup?: string): Promise<string | null> {
  return inRolledBackTx(client, async () => {
    if (setup) await client.query(setup);
    await client.query(`set local role ${role}`);
    return sqlState(client, sql);
  });
}

describe.each(API_ROLES)("as %s", (role) => {
  it("has public tables to check", () => {
    expect(publicTables.length).toBeGreaterThan(0);
    expect(internalTables.length).toBeGreaterThan(0);
  });

  it("cannot insert, update, delete or truncate any public table", async () => {
    for (const { name, firstColumn } of publicTables) {
      const table = `public.${name}`;
      const statements = [
        `insert into ${table} default values`,
        `update ${table} set ${firstColumn} = ${firstColumn}`,
        `delete from ${table}`,
        `truncate ${table}`,
      ];
      for (const sql of statements) {
        expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
      }
    }
  });

  it("cannot read any internal table", async () => {
    for (const name of internalTables) {
      const sql = `select * from internal.${name}`;
      expect({ sql, state: await stateAs(role, sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
    }
  });

  it("cannot execute a function in internal", async () => {
    const setup = "create function internal.t02_probe() returns int language sql as 'select 1'";
    expect(await stateAs(role, "select internal.t02_probe()", setup)).toBe(INSUFFICIENT_PRIVILEGE);
    const { rows } = await inRolledBackTx(client, async () => {
      await client.query(setup);
      return client.query<{ can: boolean }>(
        "select has_function_privilege($1, 'internal.t02_probe()', 'EXECUTE') as can",
        [role],
      );
    });
    expect(rows[0]?.can).toBe(false);
  });

  it("cannot send to or read from the queues", async () => {
    expect(await stateAs(role, "select pgmq.send('invoice_events', '{}'::jsonb)")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stateAs(role, "select * from pgmq.read('invoice_events', 30, 1)")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stateAs(role, "select * from pgmq.q_invoice_events")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stateAs(role, "select * from pgmq.q_invoice_events_dlq")).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("gets no grants on a table created later in public", async () => {
    // T22's migration granted SELECT table by table; a later table gets nothing until a migration grants it.
    const setup = "create table public.t02_probe (id int)";
    expect(await stateAs(role, "select * from public.t02_probe", setup)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stateAs(role, "insert into public.t02_probe values (1)", setup)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("cannot execute a function created later in public", async () => {
    const setup = "create function public.t02_probe() returns int language sql as 'select 1'";
    expect(await stateAs(role, "select public.t02_probe()", setup)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("as anon", () => {
  it("cannot select any public table", async () => {
    for (const { name } of publicTables) {
      const sql = `select * from public.${name}`;
      expect({ sql, state: await stateAs("anon", sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
    }
  });

  it("has no usage on schema internal", async () => {
    const { rows } = await client.query<{ usage: boolean }>("select has_schema_privilege('anon', 'internal', 'USAGE') as usage");
    expect(rows[0]?.usage).toBe(false);
  });
});

describe("as authenticated (T22)", () => {
  it("can select every public table but sees no rows without allowlist claims", async () => {
    // A row in every table the dashboard reads (year 2031 keeps them apart from the shared db), so the
    // empty results below are RLS hiding rows, not empty tables.
    const setup = `
      insert into public.customer (canonical_id, display_name) values ('t02-probe', 'T02 Probe') on conflict do nothing;
      insert into public.invoice
        (source, source_doc_id, source_customer, canonical_customer_id, invoice_date, currency, amount,
         source_version, mapping_version, candidate, raw_ref)
      values ('erpnext', 'T02-A1', 'T02 Probe', 't02-probe', '2031-06-01', 'USD', 10.00, 'v1', 1, '{}', 'r');
      insert into public.quarantine (source, source_doc_id, reason_code, source_version)
      values ('legacy_unit_b', 'T02-Q1', 'MISSING_FIELD', 'v1');
      insert into public.sync_run (source) values ('erpnext');
      insert into public.dead_letter (msg_id, attempts, payload) values (-202, 5, '{}');`;
    const seeded = ["customer", "invoice", "quarantine", "sync_run", "dead_letter"];
    for (const { name } of publicTables) {
      const { before, rows } = await inRolledBackTx(client, async () => {
        await client.query(setup);
        const before = Number((await client.query<{ n: string }>(`select count(*) as n from public.${name}`)).rows[0]?.n);
        await client.query("set local role authenticated");
        return { before, rows: (await client.query(`select * from public.${name}`)).rows };
      });
      if (seeded.includes(name)) expect({ name, visibleToPostgres: before > 0 }).toEqual({ name, visibleToPostgres: true });
      expect({ name, rows }).toEqual({ name, rows: [] });
    }
  });

  it("has usage on schema internal, only for the allowlist check", async () => {
    const { rows } = await client.query<{ usage: boolean }>(
      "select has_schema_privilege('authenticated', 'internal', 'USAGE') as usage",
    );
    expect(rows[0]?.usage).toBe(true);
  });
});

describe("as service_role", () => {
  it("still reads public and internal tables", async () => {
    expect(await stateAs("service_role", "select * from public.invoice")).toBeNull();
    expect(await stateAs("service_role", "select * from internal.mapping_state")).toBeNull();
  });

  it("can execute a function created later in internal", async () => {
    const setup = "create function internal.t02_probe() returns int language sql as 'select 1'";
    expect(await stateAs("service_role", "select internal.t02_probe()", setup)).toBeNull();
  });
});
