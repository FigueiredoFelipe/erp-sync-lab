import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import type { ErpInvoiceDoc } from "../../src/core/adapters/erpnext/adapter.ts";
import { processBatch, TestSwitchCrash } from "../../src/services/consumer-service.ts";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { connect, inRolledBackTx } from "./db.ts";
import { pgRpc, send, testDocs } from "./consumer-support.ts";
import { applyBranchMigrations } from "./branch-migrations.ts";

// T9 end to end against the LOCAL database: the five recorded fixture invoices go through the queue,
// processBatch (as service_role, through the same public wrappers supabase-js calls) and apply_record.
// Everything runs in one transaction that is rolled back. Inside it the queue is emptied first, so the
// batch sees only this test's messages; the rollback puts back anything another agent had queued.
// This branch's migrations are applied inside that transaction first.

let client: pg.Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

const NOW = () => new Date();

async function totals(names: string[]): Promise<{ count: number; sum: string }> {
  const { rows } = await client.query<{ count: number; sum: string }>(
    "select count(*)::int as count, coalesce(sum(amount), 0)::text as sum from public.invoice where source = 'erpnext' and source_doc_id = any($1)",
    [names],
  );
  return rows[0]!;
}

async function queueDepth(): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from pgmq.q_invoice_events");
  return rows[0]!.n;
}

async function setup(docs: ErpInvoiceDoc[]): Promise<void> {
  await applyBranchMigrations(client);
  await client.query("delete from pgmq.q_invoice_events");
  for (const doc of docs) await send(client, recordMessage(doc));
}

const rpc = () => pgRpc(client, "service_role");

// Seconds until the message becomes visible again. Own statement, so it sees set_vt's write.
async function hiddenFor(msgId: string): Promise<number> {
  const { rows } = await client.query<{ secs: string }>(
    "select extract(epoch from vt - clock_timestamp()) as secs from pgmq.q_invoice_events where msg_id = $1",
    [msgId],
  );
  return Number(rows[0]!.secs);
}

async function attemptsOf(msgId: string): Promise<number | null> {
  const { rows } = await client.query<{ attempts: number }>("select attempts from internal.message_attempt where msg_id = $1", [msgId]);
  return rows[0]?.attempts ?? null;
}

function expectedSum(docs: ErpInvoiceDoc[]): string {
  return docs.reduce((sum, doc) => sum + Number(doc.base_net_total), 0).toFixed(2);
}

describe("invoice consumer end to end (local DB)", () => {
  it("stores the five fixture invoices once, and a second pass changes nothing (AC01, R07)", async () => {
    await inRolledBackTx(client, async () => {
      const docs = testDocs();
      const names = docs.map((doc) => doc.name!);
      await setup(docs);

      const first = await processBatch({ rpc: rpc(), now: NOW });
      expect(first).toMatchObject({ read: 5, valid: 5, invalid: 0, failed: 0 });
      expect(await totals(names)).toEqual({ count: 5, sum: expectedSum(docs) }); // 10922.00
      expect(await queueDepth()).toBe(0);
      const { rows: q } = await client.query("select 1 from public.quarantine where source_doc_id = any($1)", [names]);
      expect(q).toHaveLength(0);

      // The same records again, as if the poll and the webhook both delivered them.
      for (const doc of docs) await send(client, recordMessage(doc));
      const second = await processBatch({ rpc: rpc(), now: NOW });
      expect(second).toMatchObject({ read: 5, valid: 5, failed: 0 });
      expect(await totals(names)).toEqual({ count: 5, sum: expectedSum(docs) });

      // An empty queue: nothing read, nothing changed, heartbeat written.
      const third = await processBatch({ rpc: rpc(), now: NOW });
      expect(third.read).toBe(0);
      expect(await totals(names)).toEqual({ count: 5, sum: expectedSum(docs) });
      const { rows: hb } = await client.query<{ processed: number }>("select processed from public.consumer_heartbeat");
      expect(hb[0]!.processed).toBe(0);
    });
  });

  it("after a crash past the 3rd message, every invoice of the batch is stored exactly once (AC03, EC04)", async () => {
    await inRolledBackTx(client, async () => {
      const docs = testDocs();
      const names = docs.map((doc) => doc.name!);
      await setup(docs);

      const crash = processBatch({ rpc: rpc(), now: NOW, testSwitch: async () => true });
      await expect(crash).rejects.toBeInstanceOf(TestSwitchCrash);
      expect((await totals(names)).count).toBe(3);
      expect(await queueDepth()).toBe(2);

      // Stand-in for the 180 s visibility timeout running out.
      await client.query("update pgmq.q_invoice_events set vt = clock_timestamp() - interval '1 second'");

      const retry = await processBatch({ rpc: rpc(), now: NOW });
      expect(retry).toMatchObject({ read: 2, valid: 2, failed: 0 });
      expect(await totals(names)).toEqual({ count: 5, sum: expectedSum(docs) });
      expect(await queueDepth()).toBe(0);
    });
  });

  it("a draft message fails, is backed off through the real set_invoice_event_vt, and never reaches the figures (AC06)", async () => {
    await inRolledBackTx(client, async () => {
      const doc = testDocs()[0]!;
      await setup([]);
      const msgId = await send(client, recordMessage({ ...doc, docstatus: 0 }));

      const result = await processBatch({ rpc: rpc(), now: NOW });
      expect(result).toMatchObject({ read: 1, failed: 1, valid: 0, invalid: 0 });
      expect((await totals([doc.name!])).count).toBe(0);
      expect(await queueDepth()).toBe(1);
      expect(await attemptsOf(msgId)).toBe(1);
      const secs = await hiddenFor(msgId);
      expect(secs).toBeGreaterThan(20); // backoffSeconds(1) = 30, not the 180 s read visibility
      expect(secs).toBeLessThanOrEqual(31);
    });
  });

  it("applies a message at attempt 5 and dead-letters one that comes back at attempt 6", async () => {
    await inRolledBackTx(client, async () => {
      const [a, b] = testDocs();
      await setup([]);
      const atFive = await send(client, recordMessage(a!));
      const atSix = await send(client, recordMessage(b!));
      // Four and five earlier attempts: this run is attempt 5 for the first and 6 for the second.
      await client.query("insert into internal.message_attempt (msg_id, attempts, last_attempt_at) values ($1, 4, now()), ($2, 5, now())", [
        atFive,
        atSix,
      ]);

      const result = await processBatch({ rpc: rpc(), now: NOW });
      expect(result).toMatchObject({ read: 2, valid: 1, deadLettered: 1, failed: 0 });
      expect((await totals([a!.name!])).count).toBe(1);
      expect((await totals([b!.name!])).count).toBe(0);
      expect(await attemptsOf(atFive)).toBeNull();
      expect(await attemptsOf(atSix)).toBeNull();
      expect(await queueDepth()).toBe(0);
      const { rows: dl } = await client.query("select source_doc_id, attempts, last_error from public.dead_letter where msg_id = $1", [atSix]);
      expect(dl).toEqual([{ source_doc_id: b!.name, attempts: 6, last_error: "exceeded 5 attempts without completing" }]);
      const { rows } = await client.query<{ parked: number; processed: number }>("select parked, processed from public.consumer_heartbeat");
      expect(rows[0]).toEqual({ parked: 1, processed: 1 });
    });
  });

  it("moves a malformed message to the DLQ after 5 attempts and never retries it (AC13)", async () => {
    await inRolledBackTx(client, async () => {
      await setup([]);
      const msgId = await send(client, { v: 1, kind: "record", source: "erpnext", sourceDocId: "T13TEST-MALFORMED" });
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await processBatch({ rpc: rpc(), now: NOW });
        expect({ attempt, read: result.read, failed: result.failed, deadLettered: result.deadLettered }).toEqual({
          attempt,
          read: 1,
          failed: 1,
          deadLettered: attempt === 5 ? 1 : 0,
        });
        // Stand-in for the backoff running out.
        await client.query("update pgmq.q_invoice_events set vt = clock_timestamp() - interval '1 second'");
      }
      expect(await queueDepth()).toBe(0);
      const { rows: dlq } = await client.query("select message from pgmq.q_invoice_events_dlq where message->>'sourceDocId' = 'T13TEST-MALFORMED'");
      expect(dlq).toHaveLength(1);
      const { rows: dl } = await client.query("select source, source_doc_id, attempts from public.dead_letter where msg_id = $1", [msgId]);
      expect(dl).toEqual([{ source: "erpnext", source_doc_id: "T13TEST-MALFORMED", attempts: 5 }]);
      const sixth = await processBatch({ rpc: rpc(), now: NOW });
      expect(sixth.read).toBe(0);
      const { rows: hb } = await client.query<{ parked: number }>("select parked from public.consumer_heartbeat");
      expect(hb[0]!.parked).toBe(0);
    });
  });
});
