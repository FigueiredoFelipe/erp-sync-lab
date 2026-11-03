import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { connect, inRolledBackTx, INSUFFICIENT_PRIVILEGE, sqlState } from "./db.ts";
import { apply, cleanup, messageExists, outcomeOf, send, testDocs, withVersion } from "./consumer-support.ts";
import { applyBranchMigrations, currentMappingVersion } from "./branch-migrations.ts";
import type { ErpInvoiceDoc } from "../../src/core/adapters/erpnext/adapter.ts";

// T9: internal.apply_record through its public wrapper (PLAN "Idempotency and versioning").
// Each test runs in a rolled-back transaction, except the concurrency test, which commits under
// test-only names and cleans up after itself. The rolled-back tests apply this branch's migrations first;
// the committed ones run against what the local db has applied, so their outcomes use its mapping_version.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

let mv = 0;
const oc = (doc: ErpInvoiceDoc) => outcomeOf(doc, mv);

// A rolled-back transaction with this branch's migrations applied.
async function inBranchTx(fn: () => Promise<void>): Promise<void> {
  await inRolledBackTx(client, async () => {
    await applyBranchMigrations(client);
    mv = await currentMappingVersion(client);
    await fn();
  });
}

async function invoiceRows(name: string) {
  const { rows } = await client.query<{ amount: string; source_version: string; canonical_customer_id: string | null; source_customer: string }>(
    "select amount, source_version, canonical_customer_id, source_customer from public.invoice where source = 'erpnext' and source_doc_id = $1",
    [name],
  );
  return rows;
}

async function lineCount(name: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from public.invoice_line where source = 'erpnext' and source_doc_id = $1",
    [name],
  );
  return rows[0]!.n;
}

async function quarantineRow(name: string) {
  const { rows } = await client.query<{ reason_code: string; status: string; resolution: string | null; detail: string | null }>(
    "select reason_code, status, resolution, detail from public.quarantine where source = 'erpnext' and source_doc_id = $1",
    [name],
  );
  return rows[0];
}

describe("apply_record", () => {
  it("inserts a valid invoice with its lines, deletes the message in the same transaction", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!; // 1166.00, two lines
      const msgId = await send(client, recordMessage(doc));
      expect(await apply(client, oc(doc), msgId)).toBe("valid");
      expect(await invoiceRows(doc.name!)).toEqual([
        { amount: "1166.00", source_version: "1|2026-10-17 20:39:07.886022", canonical_customer_id: "blue-ridge-kitchens", source_customer: "Blue Ridge Kitchens" },
      ]);
      expect(await lineCount(doc.name!)).toBe(2);
      expect(await messageExists(client, msgId)).toBe(false);
    });
  });

  it("stores the same message applied twice once (R07, AC01)", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[1]!;
      const msgId = await send(client, recordMessage(doc));
      expect(await apply(client, oc(doc), msgId)).toBe("valid");
      expect(await apply(client, oc(doc), msgId)).toBe("valid");
      expect(await invoiceRows(doc.name!)).toHaveLength(1);
      expect(await lineCount(doc.name!)).toBe(4);
    });
  });

  it("ignores an older version after a newer one ('stale') and still deletes its message", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      const newer = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
      newer.base_net_total = 1166;
      const older = withVersion(doc, 1, "2026-10-17 09:00:00.000000");
      older.base_net_total = 1; // would be a TOTAL_MISMATCH if applied
      await apply(client, oc(newer), await send(client, recordMessage(newer)));
      const olderMsg = await send(client, recordMessage(older));
      expect(await apply(client, oc(older), olderMsg)).toBe("stale");
      expect(await invoiceRows(doc.name!)).toEqual([expect.objectContaining({ source_version: "1|2026-10-18 10:00:00.000000" })]);
      expect(await quarantineRow(doc.name!)).toBeUndefined();
      expect(await messageExists(client, olderMsg)).toBe(false);
    });
  });

  it("moves a valid invoice that becomes invalid to quarantine and out of the figures (EC10)", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[2]!;
      await apply(client, oc(doc), await send(client, recordMessage(doc)));
      const broken = withVersion(doc, 1, "2026-10-18 11:00:00.000000");
      broken.base_net_total = 99;
      expect(await apply(client, oc(broken), await send(client, recordMessage(broken)))).toBe("invalid");
      expect(await invoiceRows(doc.name!)).toEqual([]);
      expect(await lineCount(doc.name!)).toBe(0);
      expect(await quarantineRow(doc.name!)).toMatchObject({ reason_code: "TOTAL_MISMATCH", status: "open", resolution: null });
    });
  });

  it("resolves the quarantine row when a later version is valid", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[2]!;
      const broken = withVersion(doc, 1, "2026-10-18 11:00:00.000000");
      broken.base_net_total = 99;
      await apply(client, oc(broken), 0);
      const fixed = withVersion(doc, 1, "2026-10-18 12:00:00.000000");
      expect(await apply(client, oc(fixed), 0)).toBe("valid");
      expect(await quarantineRow(doc.name!)).toMatchObject({ status: "resolved", resolution: "valid" });
      expect(await invoiceRows(doc.name!)).toHaveLength(1);
    });
  });

  it("removes a cancelled invoice and resolves its open quarantine row (BR01)", async () => {
    await inBranchTx(async () => {
      const [a, b] = testDocs();
      await apply(client, oc(a!), 0);
      const cancelledA = withVersion(a!, 2, "2026-10-18 13:00:00.000000");
      expect(await apply(client, oc(cancelledA), 0)).toBe("cancelled");
      expect(await invoiceRows(a!.name!)).toEqual([]);

      const brokenB = withVersion(b!, 1, "2026-10-18 11:00:00.000000");
      brokenB.currency = "EUR";
      expect(await apply(client, oc(brokenB), 0)).toBe("invalid");
      expect(await apply(client, oc(withVersion(b!, 2, "2026-10-18 13:00:00.000000")), 0)).toBe("cancelled");
      expect(await quarantineRow(b!.name!)).toMatchObject({ reason_code: "UNSUPPORTED_CURRENCY", status: "resolved", resolution: "cancelled" });
    });
  });

  it("a cancellation outranks a submission with a later modified", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      await apply(client, oc(withVersion(doc, 2, "2026-10-18 01:00:00.000000")), 0);
      expect(await apply(client, oc(withVersion(doc, 1, "2026-10-18 23:00:00.000000")), 0)).toBe("stale");
      expect(await invoiceRows(doc.name!)).toEqual([]);
    });
  });

  it("applies over a record_version row that has only an enqueued_version (written by the producer)", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      await client.query(
        "insert into internal.record_version (source, source_doc_id, enqueued_version) values ('erpnext', $1, '1|2026-10-17 20:39:07.886022')",
        [doc.name],
      );
      expect(await apply(client, oc(doc), 0)).toBe("valid");
    });
  });

  it("rolls back the guard and keeps the message when the apply fails", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      const msgId = await send(client, recordMessage(doc));
      const outcome = oc(doc);
      outcome.candidate.invoiceDate = null; // violates invoice.invoice_date not null after the guard ran
      await client.query("savepoint s");
      await expect(apply(client, outcome, msgId)).rejects.toThrow();
      await client.query("rollback to savepoint s");
      expect(await messageExists(client, msgId)).toBe(true);
      const { rows } = await client.query("select 1 from internal.record_version where source_doc_id = $1", [doc.name]);
      expect(rows).toHaveLength(0);
    });
  });

  it("refuses a draft version ('0|...') and never writes it to public.invoice (BR01, AC06)", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      const msgId = await send(client, recordMessage(doc));
      const draftVersion = "0|2026-10-17 20:39:07.886022";
      const outcome = oc(doc);
      const draft = { ...outcome, sourceVersion: draftVersion, candidate: { ...outcome.candidate, sourceVersion: draftVersion } };
      await client.query("savepoint s");
      await expect(apply(client, draft, msgId)).rejects.toThrow(/invalid sourceVersion/);
      await client.query("rollback to savepoint s");
      expect(await invoiceRows(doc.name!)).toEqual([]);
      expect(await messageExists(client, msgId)).toBe(true);
    });
  });

  it("compares versions in byte order (COLLATE \"C\"), independent of the database collation", async () => {
    const { rows } = await client.query<{ def: string }>(
      "select pg_get_functiondef('internal.apply_record(jsonb, bigint)'::regprocedure) as def",
    );
    expect(rows[0]!.def).toMatch(/rv\.applied_version collate "C" <= excluded\.applied_version collate "C"/i);
  });

  it("replaces the line set when a newer version has fewer, different lines", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[1]!; // four lines
      expect(await apply(client, oc(doc), 0)).toBe("valid");
      expect(await lineCount(doc.name!)).toBe(4);

      const v2 = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
      const line = { ...v2.items![0]!, item_code: "T9TEST-ONLY-ITEM" };
      v2.items = [line];
      v2.base_net_total = line.base_net_amount!;
      expect(await apply(client, oc(v2), 0)).toBe("valid");
      const { rows } = await client.query<{ line_no: number; item_code: string }>(
        "select line_no, item_code from public.invoice_line where source = 'erpnext' and source_doc_id = $1 order by line_no",
        [doc.name],
      );
      expect(rows).toEqual([{ line_no: 1, item_code: "T9TEST-ONLY-ITEM" }]);
    });
  });

  it("deletes the message_attempt row after an apply and after a stale drop", async () => {
    await inBranchTx(async () => {
      const doc = testDocs()[0]!;
      const attemptRows = async (msgId: string) =>
        (await client.query("select 1 from internal.message_attempt where msg_id = $1", [msgId])).rows.length;

      const newer = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
      const newerMsg = await send(client, recordMessage(newer));
      await client.query("select public.begin_attempt($1)", [newerMsg]);
      expect(await attemptRows(newerMsg)).toBe(1);
      expect(await apply(client, oc(newer), newerMsg)).toBe("valid");
      expect(await attemptRows(newerMsg)).toBe(0);

      const older = withVersion(doc, 1, "2026-10-17 09:00:00.000000");
      const olderMsg = await send(client, recordMessage(older));
      await client.query("select public.begin_attempt($1)", [olderMsg]);
      expect(await apply(client, oc(older), olderMsg)).toBe("stale");
      expect(await attemptRows(olderMsg)).toBe(0);
    });
  });

  it("rejects an outcome whose candidate describes another record", async () => {
    await inBranchTx(async () => {
      const [a, b] = testDocs();
      const outcome = { ...oc(a!), candidate: oc(b!).candidate };
      await client.query("savepoint s");
      await expect(apply(client, outcome, 0)).rejects.toThrow(/differs/);
      await client.query("rollback to savepoint s");
    });
  });
});

describe("apply_record under concurrency", () => {
  it("the newer version wins when it commits first and the older one waits on the row lock", async () => {
    const other = await connect();
    const doc = testDocs()[0]!;
    mv = await currentMappingVersion(client);
    try {
      const newer = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
      const older = withVersion(doc, 1, "2026-10-17 09:00:00.000000");
      older.base_net_total = 1; // invalid: would quarantine the record if it won

      await client.query("begin");
      await other.query("begin");
      expect(await apply(client, oc(newer), 0)).toBe("valid");

      const { rows } = await other.query<{ pid: number }>("select pg_backend_pid() as pid");
      const otherPid = rows[0]!.pid;
      const olderApply = apply(other, oc(older), 0);
      await waitUntilBlocked(otherPid);

      await client.query("commit");
      expect(await olderApply).toBe("stale");
      await other.query("commit");

      expect(await invoiceRows(doc.name!)).toEqual([expect.objectContaining({ source_version: "1|2026-10-18 10:00:00.000000", amount: "1166.00" })]);
      expect(await quarantineRow(doc.name!)).toBeUndefined();
    } finally {
      await client.query("rollback").catch(() => undefined);
      await other.query("rollback").catch(() => undefined);
      await cleanup(client, [doc.name!]);
      await other.end();
    }
  });

  it("the newer version wins when the older one holds the lock first", async () => {
    const other = await connect();
    const doc = testDocs()[1]!;
    mv = await currentMappingVersion(client);
    try {
      const older = withVersion(doc, 1, "2026-10-17 09:00:00.000000");
      older.base_net_total = 1;
      const newer = withVersion(doc, 1, "2026-10-18 10:00:00.000000");

      await client.query("begin");
      await other.query("begin");
      expect(await apply(client, oc(older), 0)).toBe("invalid");
      const { rows } = await other.query<{ pid: number }>("select pg_backend_pid() as pid");
      const newerApply = apply(other, oc(newer), 0);
      await waitUntilBlocked(rows[0]!.pid);
      await client.query("commit");
      expect(await newerApply).toBe("valid");
      await other.query("commit");

      expect(await invoiceRows(doc.name!)).toHaveLength(1);
      expect(await quarantineRow(doc.name!)).toMatchObject({ status: "resolved", resolution: "valid" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      await other.query("rollback").catch(() => undefined);
      await cleanup(client, [doc.name!]);
      await other.end();
    }
  });
});

// Polls from a third connection until `pid` waits on a lock, so the interleaving is forced, not timed.
async function waitUntilBlocked(pid: number): Promise<void> {
  const watcher = await connect();
  try {
    for (let i = 0; i < 100; i++) {
      const { rows } = await watcher.query("select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid]);
      if (rows.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`backend ${pid} never blocked on a lock`);
  } finally {
    await watcher.end();
  }
}

describe("grants on the consumer wrappers", () => {
  const WRAPPERS = [
    "public.read_invoice_events(integer, integer)",
    "public.begin_attempt(bigint)",
    "public.apply_record(jsonb, bigint)",
    "public.set_invoice_event_vt(bigint, integer)",
    "public.write_consumer_heartbeat(integer, interval, integer)",
    "public.test_switch_enabled(text)",
  ];
  const INTERNAL = ["internal.begin_attempt(bigint)", "internal.apply_record(jsonb, bigint)", "internal.trigger_consumer()"];

  async function canExecute(role: string, fn: string): Promise<boolean> {
    const { rows } = await client.query<{ can: boolean }>("select has_function_privilege($1, $2, 'EXECUTE') as can", [role, fn]);
    return rows[0]!.can;
  }

  it.each(["anon", "authenticated"])("%s can execute none of them", async (role) => {
    for (const fn of [...WRAPPERS, ...INTERNAL]) expect({ fn, can: await canExecute(role, fn) }).toEqual({ fn, can: false });
    const state = await inRolledBackTx(client, async () => {
      await client.query(`set local role ${role}`);
      return sqlState(client, "select public.test_switch_enabled('x')");
    });
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("service_role can execute every wrapper", async () => {
    for (const fn of WRAPPERS) expect({ fn, can: await canExecute("service_role", fn) }).toEqual({ fn, can: true });
    const state = await inRolledBackTx(client, async () => {
      await client.query("set local role service_role");
      return sqlState(client, "select public.test_switch_enabled('x')");
    });
    expect(state).toBeNull();
  });
});

describe("begin_attempt, set_invoice_event_vt, heartbeat and test switch", () => {
  it("counts attempts per message", async () => {
    await inBranchTx(async () => {
      const { rows } = await client.query<{ a: number; b: number }>(
        "select public.begin_attempt(-42) as a, public.begin_attempt(-42) as b",
      );
      expect([rows[0]!.a, rows[0]!.b].sort()).toEqual([1, 2]);
    });
  });

  it("hides a message for the backoff", async () => {
    await inBranchTx(async () => {
      const msgId = await send(client, { v: 1 });
      // Two statements: a subquery in the same SELECT would read the snapshot from before set_vt.
      const { rows: set } = await client.query<{ ok: boolean }>("select public.set_invoice_event_vt($1, 120) as ok", [msgId]);
      expect(set[0]!.ok).toBe(true);
      const { rows } = await client.query<{ secs: number }>(
        "select extract(epoch from vt - clock_timestamp()) as secs from pgmq.q_invoice_events where msg_id = $1",
        [msgId],
      );
      expect(Number(rows[0]!.secs)).toBeGreaterThan(100);
    });
  });

  it("writes the heartbeat; parked is the number of messages this run moved to the DLQ", async () => {
    await inBranchTx(async () => {
      await client.query("select public.write_consumer_heartbeat(7, '12 seconds', 2)");
      const { rows } = await client.query<{ processed: number; age: string; recent: boolean; parked: number }>(
        "select processed, oldest_message_age::text as age, last_run_at = now() as recent, parked from public.consumer_heartbeat",
      );
      expect(rows[0]).toEqual({ processed: 7, age: "00:00:12", recent: true, parked: 2 });
    });
  });

  it("commits begin_attempt on its own, so a failed apply still counts the attempt", async () => {
    // Autocommit, as each supabase-js RPC is its own transaction. A msg_id that is not in the queue keeps
    // this off the shared queue; the row is removed afterwards.
    const msgId = -900_001;
    const doc = testDocs()[0]!;
    mv = await currentMappingVersion(client);
    try {
      const { rows: first } = await client.query<{ a: number }>("select public.begin_attempt($1) as a", [msgId]);
      expect(first[0]!.a).toBe(1);
      const outcome = oc(doc);
      outcome.candidate.invoiceDate = null; // fails inside apply_record, after the guard
      await expect(apply(client, outcome, msgId)).rejects.toThrow();
      const { rows } = await client.query<{ attempts: number }>("select attempts from internal.message_attempt where msg_id = $1", [msgId]);
      expect(rows).toEqual([{ attempts: 1 }]);
      const { rows: guard } = await client.query("select 1 from internal.record_version where source_doc_id = $1", [doc.name]);
      expect(guard).toHaveLength(0);
    } finally {
      await client.query("delete from internal.message_attempt where msg_id = $1", [msgId]);
      await cleanup(client, [doc.name!]);
    }
  });

  it("reads test switches, off by default", async () => {
    await inRolledBackTx(client, async () => {
      await client.query("delete from internal.test_switch where name = 'consumer_throw_after_3'");
      const off = await client.query<{ v: boolean }>("select public.test_switch_enabled('consumer_throw_after_3') as v");
      expect(off.rows[0]!.v).toBe(false);
      await client.query("insert into internal.test_switch (name, enabled) values ('consumer_throw_after_3', true)");
      const on = await client.query<{ v: boolean }>("select public.test_switch_enabled('consumer_throw_after_3') as v");
      expect(on.rows[0]!.v).toBe(true);
    });
  });
});

describe("cron schedule", () => {
  it("schedules invoice-consumer every minute through internal.trigger_consumer", async () => {
    const { rows } = await client.query<{ schedule: string; command: string }>(
      "select schedule, command from cron.job where jobname = 'invoice-consumer'",
    );
    expect(rows).toEqual([{ schedule: "* * * * *", command: "select internal.trigger_consumer()" }]);
  });
});
