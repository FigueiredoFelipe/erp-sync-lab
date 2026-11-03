import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { applyBranchMigrations, currentMappingVersion } from "./branch-migrations.ts";
import { apply, messageExists, outcomeOf, send, testDocs } from "./consumer-support.ts";
import { connect, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";

// T8: internal.apply_customer_mapping, the shipped mapping, load_customer_index and the mapping_version check
// in apply_record (LOCAL db). Each test runs in a rolled-back transaction with this branch's migrations.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await applyBranchMigrations(client);
});

afterEach(async () => {
  await client.query("rollback");
});

async function applyMapping(mapping: unknown): Promise<number> {
  const { rows } = await client.query<{ v: number }>("select internal.apply_customer_mapping($1::jsonb) as v", [JSON.stringify(mapping)]);
  return rows[0]!.v;
}

async function failsWith(sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query("savepoint s");
  try {
    await client.query(sql, params);
    await client.query("release savepoint s");
    return null;
  } catch (error) {
    await client.query("rollback to savepoint s");
    return (error as { code?: string }).code ?? "unknown";
  }
}

describe("the shipped mapping", () => {
  it("lists 18 canonical customers", async () => {
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from public.customer");
    expect(rows[0]!.n).toBe(18);
  });

  it("stores ACME FOODS as the Unit B alias of Acme Foods Inc.", async () => {
    const { rows } = await client.query(
      `select c.canonical_id, c.display_name from internal.customer_alias a join public.customer c using (canonical_id)
       where a.source = 'legacy_unit_b' and a.match_key = 'ACME FOODS'`,
    );
    expect(rows).toEqual([{ canonical_id: "acme-foods", display_name: "Acme Foods Inc." }]);
  });

  it("has 15 ERPNext aliases and 9 Unit B aliases, stored as written", async () => {
    const { rows } = await client.query<{ source: string; n: number }>(
      "select source, count(*)::int as n from internal.customer_alias group by source order by source",
    );
    expect(rows).toEqual([
      { source: "erpnext", n: 15 },
      { source: "legacy_unit_b", n: 9 },
    ]);
    const { rows: redwood } = await client.query("select match_key from internal.customer_alias where canonical_id = 'redwood-pizza-kitchen' order by source");
    expect(redwood.map((r) => r.match_key)).toEqual(["Redwood Pizza Kitchen", "REDWOOD  PIZZA KITCHEN"]);
  });
});

describe("internal.apply_customer_mapping", () => {
  const small = [
    { canonical_id: "acme-co", display_name: "Acme Co", erpnext: ["Acme Co"], legacy_unit_b: ["ACME CO"] },
    { canonical_id: "acme-inc", display_name: "Acme Inc", erpnext: ["Acme Inc"] },
  ];

  it("replaces customers and aliases and bumps mapping_version by one", async () => {
    const before = await currentMappingVersion(client);
    expect(await applyMapping(small)).toBe(before + 1);
    expect(await currentMappingVersion(client)).toBe(before + 1);
    const { rows: customers } = await client.query("select canonical_id from public.customer order by 1");
    expect(customers.map((r) => r.canonical_id)).toEqual(["acme-co", "acme-inc"]);
    const { rows: aliases } = await client.query("select source, match_key, canonical_id from internal.customer_alias order by 1, 2");
    expect(aliases).toEqual([
      { source: "erpnext", match_key: "Acme Co", canonical_id: "acme-co" },
      { source: "erpnext", match_key: "Acme Inc", canonical_id: "acme-inc" },
      { source: "legacy_unit_b", match_key: "ACME CO", canonical_id: "acme-co" },
    ]);
  });

  it.each([
    ["not an array", { canonical_id: "x" }],
    ["a bad slug", [{ canonical_id: "Acme Co", display_name: "Acme" }]],
    ["no display name", [{ canonical_id: "acme", display_name: " " }]],
    ["a non-string alias", [{ canonical_id: "acme", display_name: "Acme", erpnext: [5] }]],
    ["an empty alias", [{ canonical_id: "acme", display_name: "Acme", legacy_unit_b: [""] }]],
    ["aliases that are not an array", [{ canonical_id: "acme", display_name: "Acme", erpnext: "Acme" }]],
  ])("refuses %s and changes nothing", async (_label, mapping) => {
    const before = await currentMappingVersion(client);
    expect(await failsWith("select internal.apply_customer_mapping($1::jsonb)", [JSON.stringify(mapping)])).toBe("22023");
    expect(await currentMappingVersion(client)).toBe(before);
  });

  it.each([
    ["a repeated canonical_id", [small[0], { ...small[1], canonical_id: "acme-co" }]],
    ["an alias listed for two customers", [small[0], { ...small[1], erpnext: ["Acme Co"] }]],
  ])("refuses %s as a whole", async (_label, mapping) => {
    const before = await currentMappingVersion(client);
    expect(await failsWith("select internal.apply_customer_mapping($1::jsonb)", [JSON.stringify(mapping)])).toBe("23505");
    expect(await currentMappingVersion(client)).toBe(before);
    const { rows } = await client.query<{ n: number }>("select count(*)::int as n from public.customer");
    expect(rows[0]!.n).toBe(18);
  });
});

describe("public.load_customer_index", () => {
  it("returns the aliases with the mapping_version they belong to", async () => {
    const { rows } = await client.query<{ v: { mappingVersion: number; aliases: { source: string; matchKey: string; canonicalId: string }[] } }>(
      "select public.load_customer_index() as v",
    );
    expect(rows[0]!.v.mappingVersion).toBe(await currentMappingVersion(client));
    expect(rows[0]!.v.aliases).toHaveLength(24);
    expect(rows[0]!.v.aliases).toContainEqual({ source: "legacy_unit_b", matchKey: "ACME FOODS", canonicalId: "acme-foods" });
  });

  it("is executable by service_role only; apply_customer_mapping by nobody through the API", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(await failsWith(`set local role ${role}; select public.load_customer_index()`)).toBe(INSUFFICIENT_PRIVILEGE);
      await client.query("reset role");
      expect(await failsWith(`set local role ${role}; select internal.apply_customer_mapping('[]')`)).toBe(INSUFFICIENT_PRIVILEGE);
      await client.query("reset role");
    }
    const { rows } = await client.query<{ can: boolean; cannot: boolean }>(
      `select has_function_privilege('service_role', 'public.load_customer_index()', 'EXECUTE') as can,
              has_function_privilege('authenticated', 'internal.apply_customer_mapping(jsonb)', 'EXECUTE') as cannot`,
    );
    expect(rows[0]).toEqual({ can: true, cannot: false });
    expect(await sqlState(client, "select 1")).toBeNull();
  });
});

describe("apply_record and the mapping (BR05)", () => {
  it("stores the canonical customer and the mapping_version of a valid invoice", async () => {
    const doc = testDocs()[0]!;
    const mv = await currentMappingVersion(client);
    const msgId = await send(client, recordMessage(doc));
    expect(await apply(client, outcomeOf(doc, mv), msgId)).toBe("valid");
    const { rows } = await client.query("select canonical_customer_id, mapping_version from public.invoice where source = 'erpnext' and source_doc_id = $1", [
      doc.name,
    ]);
    expect(rows).toEqual([{ canonical_customer_id: "blue-ridge-kitchens", mapping_version: mv }]);
  });

  it("refuses, as a transient error, an outcome computed with an older mapping_version, and keeps the message", async () => {
    const doc = testDocs()[0]!;
    const mv = await currentMappingVersion(client);
    const msgId = await send(client, recordMessage(doc));
    await client.query("savepoint s");
    await expect(apply(client, outcomeOf(doc, mv - 1), msgId)).rejects.toThrow(/mapping_version/);
    await client.query("rollback to savepoint s");
    expect(await messageExists(client, msgId)).toBe(true);
    expect(await failsWith("select public.apply_record($1::jsonb, $2)", [JSON.stringify(outcomeOf(doc, mv - 1)), msgId])).toBe("40001");
  });

  it("refuses a valid outcome without a canonical customer, or with one the mapping doesn't list", async () => {
    const doc = testDocs()[0]!;
    const mv = await currentMappingVersion(client);
    const outcome = outcomeOf(doc, mv);
    expect(await failsWith("select public.apply_record($1::jsonb, 0)", [JSON.stringify({ ...outcome, canonicalCustomerId: null })])).toBe("22023");
    expect(await failsWith("select public.apply_record($1::jsonb, 0)", [JSON.stringify({ ...outcome, canonicalCustomerId: "nobody" })])).toBe("22023");
    const { mappingVersion: _drop, ...noVersion } = outcome;
    expect(await failsWith("select public.apply_record($1::jsonb, 0)", [JSON.stringify(noVersion)])).toBe("22023");
  });

  it("quarantines an unknown customer with the mapping_version it was judged under", async () => {
    const doc = { ...testDocs()[0]!, customer: "Nobody Mapped LLC" };
    const mv = await currentMappingVersion(client);
    expect(await apply(client, outcomeOf(doc, mv), 0)).toBe("invalid");
    const { rows } = await client.query("select reason_code, mapping_version, status from public.quarantine where source_doc_id = $1", [doc.name]);
    expect(rows).toEqual([{ reason_code: "UNKNOWN_CUSTOMER", mapping_version: mv, status: "open" }]);
  });
});
