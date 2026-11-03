import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { connect, createAuthUser, INSUFFICIENT_PRIVILEGE, setJwtClaims, sqlState } from "./db.ts";

// T22 (AC10 at the database level): internal.is_allowlisted(), the allowlisted_read policies, the read-only
// grants and the dashboard wrappers from 20261019100000_auth_allowlist.sql, with the identity-based check of
// 20261019110000_allowlist_identity.sql, on the LOCAL stack.
// Each test runs in a transaction that is rolled back, so the shared db is untouched.

const ALLOWED = "t22-allowed@example.com";
const OTHER = "t22-other@example.com";

// Auth users created per test (rolled back): the allowlisted Google user, a Google user off the allowlist,
// and a user whose only identity is email/password under the allowlisted address.
const ALLOWED_ID = "22222222-0000-4000-8000-000000000001";
const OTHER_ID = "22222222-0000-4000-8000-000000000002";
const EMAIL_ONLY_ID = "22222222-0000-4000-8000-000000000003";
const USER_IDS: Record<string, string> = { [ALLOWED]: ALLOWED_ID, [OTHER]: OTHER_ID };

// The views the dashboard services read, besides the tables.
const VIEWS = ["monthly_revenue", "revenue_document", "customer_monthly_revenue"];
// Public functions an API role may execute after T22; everything else in public is service_role only.
const CALLABLE = ["app_access", "app_queue_metrics", "app_test_switch"];

// Year 2032 keeps these rows apart from whatever the shared db holds.
const FIXTURES = `
  insert into internal.allowlist (email) values ('${ALLOWED}');
  insert into public.customer (canonical_id, display_name) values ('t22-acme', 'T22 Acme') on conflict (canonical_id) do nothing;
  insert into public.invoice
    (source, source_doc_id, source_customer, canonical_customer_id, invoice_date, currency, amount, is_credit_note,
     source_version, mapping_version, candidate, raw_ref, updated_at)
  values ('erpnext', 'T22-A1', 'T22 Acme', 't22-acme', '2032-03-31', 'USD', 100.00, false, 'v1', 1, '{}', 'r', '2032-04-01');
  insert into public.quarantine (source, source_doc_id, reason_code, source_version)
  values ('legacy_unit_b', 'T22-Q1', 'MISSING_FIELD', 'v1');
  insert into public.sync_run (source) values ('erpnext');
  insert into public.dead_letter (msg_id, attempts, payload) values (-22, 5, '{}');
`;

let client: pg.Client;
let publicTables: string[];

beforeAll(async () => {
  client = await connect();
  const { rows } = await client.query<{ name: string }>(
    `select relname as name from pg_class
     where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
  );
  publicTables = rows.map((row) => row.name);
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await client.query(FIXTURES);
  await createAuthUser(client, { id: ALLOWED_ID, email: ALLOWED });
  await createAuthUser(client, { id: OTHER_ID, email: OTHER });
});

afterEach(async () => {
  await client.query("rollback");
});

// Act as a signed-in user with these JWT claims, for the rest of the transaction. `sub` defaults to the
// auth user created for that email in beforeEach.
async function signIn(email: string, provider = "google", sub = USER_IDS[email.toLowerCase()]): Promise<void> {
  await setJwtClaims(client, { role: "authenticated", sub, email, app_metadata: { provider } });
  await client.query("set local role authenticated");
}

async function seesNothing(): Promise<void> {
  expect(await access()).toBe(false);
  for (const relation of [...publicTables, ...VIEWS]) {
    expect({ relation, n: await count(relation) }).toEqual({ relation, n: 0 });
  }
}

// Runs `fn` as postgres, then returns to the role the transaction had.
async function asPostgres<T>(fn: () => Promise<T>): Promise<T> {
  const { rows } = await client.query<{ role: string }>("select current_setting('role') as role");
  await client.query("reset role");
  try {
    return await fn();
  } finally {
    const role = rows[0]?.role;
    if (role && role !== "none") await client.query(`set local role ${role}`);
  }
}

async function count(relation: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(`select count(*) as n from public.${relation}`);
  return Number(rows[0]?.n);
}

async function access(): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>("select public.app_access() as ok");
  return rows[0]!.ok;
}

// SQLSTATE of `sql` inside a savepoint, so a failure doesn't abort the surrounding transaction.
async function stateIn(sql: string): Promise<string | null> {
  await client.query("savepoint probe");
  const state = await sqlState(client, sql);
  await client.query("rollback to savepoint probe");
  return state;
}

describe("an allowlisted Google user", () => {
  it("has access and sees every row of every public table and dashboard view", async () => {
    const expected = new Map<string, number>();
    for (const relation of [...publicTables, ...VIEWS]) expected.set(relation, await count(relation));
    await signIn(ALLOWED);
    expect(await access()).toBe(true);
    for (const [relation, n] of expected) {
      expect({ relation, n: await count(relation) }).toEqual({ relation, n });
    }
    // The fixtures make sure the comparison isn't trivially zero where the dashboard reads.
    for (const relation of ["invoice", "customer", "quarantine", "sync_run", "dead_letter", ...VIEWS]) {
      expect({ relation, positive: (await count(relation)) > 0 }).toEqual({ relation, positive: true });
    }
  });

  it("matches the allowlist case-insensitively on the Google identity's email", async () => {
    await createAuthUser(client, { id: EMAIL_ONLY_ID, email: "x@example.com", identityEmail: ALLOWED.toUpperCase() });
    await signIn("x@example.com", "google", EMAIL_ONLY_ID);
    expect(await access()).toBe(true);
  });
});

// The identity check (review fix): the allowlist is matched against the email Google asserted for this
// user's identity, never the JWT's top-level email, which the user can change through /auth/v1/user.
describe("identity, not the editable email claim", () => {
  it("denies a Google user who changed their account email to an allowlisted one", async () => {
    // The allowlisted owner hasn't signed in yet, so the address is free in auth.users. The attacker's
    // auth.users.email (and so the JWT email) now says ALLOWED, but Google asserted OTHER.
    await client.query("delete from auth.identities where user_id = $1", [ALLOWED_ID]);
    await client.query("delete from auth.users where id = $1", [ALLOWED_ID]);
    await client.query("update auth.users set email = $1 where id = $2", [ALLOWED, OTHER_ID]);
    await signIn(ALLOWED, "google", OTHER_ID);
    await seesNothing();
  });

  it("denies a token whose sub is a different user than the allowlisted identity", async () => {
    await signIn(ALLOWED, "google", OTHER_ID);
    await seesNothing();
  });

  it("denies a token whose sub has no auth user at all", async () => {
    await signIn(ALLOWED, "google", "22222222-0000-4000-8000-0000000000ff");
    await seesNothing();
  });

  it("denies an email/password user under an allowlisted address", async () => {
    await client.query("delete from auth.identities where user_id = $1", [ALLOWED_ID]);
    await client.query("delete from auth.users where id = $1", [ALLOWED_ID]);
    await createAuthUser(client, { id: EMAIL_ONLY_ID, email: ALLOWED, provider: "email" });
    await signIn(ALLOWED, "email", EMAIL_ONLY_ID);
    await seesNothing();
  });

  it("denies the same email/password user even if its token claims provider google", async () => {
    await createAuthUser(client, { id: EMAIL_ONLY_ID, email: "y@example.com", identityEmail: ALLOWED, provider: "email" });
    await signIn(ALLOWED, "google", EMAIL_ONLY_ID);
    await seesNothing();
  });
});

describe.each([
  ["a Google user not on the allowlist", OTHER, "google"],
  ["an allowlisted email signed in with another provider", ALLOWED, "email"],
])("%s", (_label, email, provider) => {
  it("has no access and sees no rows anywhere", async () => {
    await signIn(email, provider);
    await seesNothing();
  });

  it("gets no queue metrics and every test switch off", async () => {
    await asPostgres(() => client.query("insert into internal.test_switch (name, enabled) values ('t22_probe', true)"));
    await signIn(email, provider);
    expect((await client.query("select * from public.app_queue_metrics()")).rows).toEqual([]);
    expect((await client.query("select public.app_test_switch('t22_probe') as on")).rows[0]?.on).toBe(false);
  });
});

// Malformed or partial tokens: the check needs a Google provider claim and the user's Google identity.
describe.each([
  ["a token with no sub claim", { role: "authenticated", email: ALLOWED, app_metadata: { provider: "google" } }],
  ["a token with no app_metadata.provider", { role: "authenticated", sub: ALLOWED_ID, email: ALLOWED, app_metadata: {} }],
  ["a token with no app_metadata at all", { role: "authenticated", sub: ALLOWED_ID, email: ALLOWED }],
])("%s", (_label, claims) => {
  it("has no access and sees no rows anywhere", async () => {
    await setJwtClaims(client, claims);
    await client.query("set local role authenticated");
    await seesNothing();
  });
});

describe("with no session (anon)", () => {
  it("cannot read any public table or view, nor call app_access", async () => {
    await client.query("set local role anon");
    for (const relation of [...publicTables, ...VIEWS]) {
      const sql = `select * from public.${relation}`;
      expect({ sql, state: await stateIn(sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
    }
    expect(await stateIn("select public.app_access()")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await stateIn("select internal.is_allowlisted()")).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("writes and functions, even for an allowlisted user", () => {
  it("rejects insert, update, delete and truncate on every public table", async () => {
    const { rows } = await client.query<{ name: string; first_column: string }>(
      `select c.relname as name,
              (select a.attname from pg_attribute a
               where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum limit 1) as first_column
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`,
    );
    await signIn(ALLOWED);
    for (const { name, first_column: column } of rows) {
      for (const sql of [
        `insert into public.${name} default values`,
        `update public.${name} set ${column} = ${column}`,
        `delete from public.${name}`,
        `truncate public.${name}`,
      ]) {
        expect({ sql, state: await stateIn(sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
      }
    }
  });

  it("cannot read any internal table, the allowlist included", async () => {
    const { rows } = await client.query<{ name: string }>("select tablename as name from pg_tables where schemaname = 'internal'");
    await signIn(ALLOWED);
    for (const { name } of rows) {
      const sql = `select * from internal.${name}`;
      expect({ sql, state: await stateIn(sql) }).toEqual({ sql, state: INSUFFICIENT_PRIVILEGE });
    }
  });

  it("cannot execute any internal function but is_allowlisted, nor any public function but the dashboard's", async () => {
    const { rows } = await client.query<{ schema: string; name: string; signature: string }>(
      `select n.nspname as schema, p.proname as name, p.oid::regprocedure::text as signature
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'internal')
         and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
    );
    expect(rows.length).toBeGreaterThan(CALLABLE.length + 1);
    for (const role of ["anon", "authenticated"]) {
      for (const { schema, name, signature } of rows) {
        const allowed =
          role === "authenticated" &&
          ((schema === "internal" && name === "is_allowlisted") || (schema === "public" && CALLABLE.includes(name)));
        const { rows: privilege } = await client.query<{ can: boolean }>(
          "select has_function_privilege($1, $2, 'EXECUTE') as can",
          [role, signature],
        );
        expect({ role, signature, can: privilege[0]?.can }).toEqual({ role, signature, can: allowed });
      }
    }
  });

  it("rejects a direct call to apply_record", async () => {
    await signIn(ALLOWED);
    expect(await stateIn("select public.apply_record('{}'::jsonb, 1)")).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe("dashboard wrappers", () => {
  it("answer an allowlisted user and service_role", async () => {
    await client.query("insert into internal.test_switch (name, enabled) values ('t22_probe', true)");
    await signIn(ALLOWED);
    expect((await client.query("select * from public.app_queue_metrics()")).rows).toHaveLength(2);
    expect((await client.query("select public.app_test_switch('t22_probe') as on")).rows[0]?.on).toBe(true);
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', '', true)");
    await client.query("set local role service_role");
    expect((await client.query("select * from public.app_queue_metrics()")).rows).toHaveLength(2);
    expect((await client.query("select public.app_test_switch('t22_probe') as on")).rows[0]?.on).toBe(true);
  });
});

describe("policies", () => {
  it("every public table has RLS on and exactly one policy: allowlisted_read, SELECT, for authenticated", async () => {
    for (const name of publicTables) {
      const { rows: rls } = await client.query<{ on: boolean }>(
        "select relrowsecurity as on from pg_class where oid = $1::regclass",
        [`public.${name}`],
      );
      expect({ name, rls: rls[0]?.on }).toEqual({ name, rls: true });
      const { rows: policies } = await client.query<{ policyname: string; cmd: string; roles: string[]; permissive: string }>(
        "select policyname, cmd, roles::text[] as roles, permissive from pg_policies where schemaname = 'public' and tablename = $1",
        [name],
      );
      expect({ name, policies }).toEqual({
        name,
        policies: [{ policyname: "allowlisted_read", cmd: "SELECT", roles: ["authenticated"], permissive: "PERMISSIVE" }],
      });
    }
  });

  it("is_allowlisted is SECURITY DEFINER, STABLE, with an empty search_path", async () => {
    const { rows } = await client.query<{ secdef: boolean; volatile: string; config: string[] | null }>(
      "select prosecdef as secdef, provolatile as volatile, proconfig as config from pg_proc where oid = 'internal.is_allowlisted()'::regprocedure",
    );
    expect(rows[0]).toEqual({ secdef: true, volatile: "s", config: ['search_path=""'] });
  });
});
