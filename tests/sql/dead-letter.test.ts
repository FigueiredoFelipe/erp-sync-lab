import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type pg from "pg";
import { recordMessage } from "../../src/services/test-helpers.ts";
import { applyBranchMigrations, currentMappingVersion } from "./branch-migrations.ts";
import { apply, messageExists, outcomeOf, send, testDocs, withVersion } from "./consumer-support.ts";
import { connect, INSUFFICIENT_PRIVILEGE } from "./db.ts";

// T13: internal.dead_letter through public.dead_letter_message (R13). Each test runs in a rolled-back
// transaction with this branch's migrations applied.

let client: pg.Client;
let mv: number;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("begin");
  await applyBranchMigrations(client);
  mv = await currentMappingVersion(client);
});

afterEach(async () => {
  await client.query("rollback");
});

async function deadLetter(msgId: string | number, error = "boom"): Promise<string> {
  const { rows } = await client.query<{ r: string }>("select public.dead_letter_message($1, $2) as r", [msgId, error]);
  return rows[0]!.r;
}

async function dlqPayloads(key: string): Promise<unknown[]> {
  const { rows } = await client.query("select message from pgmq.q_invoice_events_dlq where message->>'sourceDocId' = $1", [key]);
  return rows.map((r) => r.message);
}

async function invoiceCount(name: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from public.invoice where source_doc_id = $1", [name]);
  return rows[0]!.n;
}

async function quarantine(name: string) {
  const { rows } = await client.query("select reason_code, status, source_version, detail, candidate is not null as has_candidate from public.quarantine where source_doc_id = $1", [name]);
  return rows[0];
}

describe("internal.dead_letter", () => {
  it("moves a malformed message without a key to the DLQ only", async () => {
    const payload = { v: 1, kind: "record", source: "elsewhere", sourceDocId: "T13TEST-NOKEY" };
    const msgId = await send(client, payload);
    await client.query("select public.begin_attempt($1)", [msgId]);
    expect(await deadLetter(msgId, "unsupported source")).toBe("moved");
    expect(await messageExists(client, msgId)).toBe(false);
    expect(await dlqPayloads("T13TEST-NOKEY")).toEqual([payload]);
    const { rows } = await client.query("select source, source_doc_id, source_version, last_error, attempts, payload from public.dead_letter where msg_id = $1", [msgId]);
    expect(rows).toEqual([{ source: null, source_doc_id: null, source_version: null, last_error: "unsupported source", attempts: 1, payload }]);
    const { rows: att } = await client.query("select 1 from internal.message_attempt where msg_id = $1", [msgId]);
    expect(att).toHaveLength(0);
  });

  it("with no invoice row for the key: DLQ only, no quarantine", async () => {
    const doc = testDocs()[0]!;
    const msgId = await send(client, recordMessage(doc));
    expect(await deadLetter(msgId)).toBe("moved");
    const { rows } = await client.query("select source, source_doc_id, source_version from public.dead_letter where msg_id = $1", [msgId]);
    expect(rows).toEqual([{ source: "erpnext", source_doc_id: doc.name, source_version: "1|2026-10-17 20:39:07.886022" }]);
    expect(await quarantine(doc.name!)).toBeUndefined();
  });

  it("takes an older valid version out of the figures and quarantines it as PROCESSING_FAILED (R13)", async () => {
    const doc = testDocs()[1]!;
    expect(await apply(client, outcomeOf(doc, mv), 0)).toBe("valid");
    const newer = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
    const msgId = await send(client, recordMessage(newer));
    expect(await deadLetter(msgId, "kept failing")).toBe("moved");
    expect(await invoiceCount(doc.name!)).toBe(0);
    const { rows: lines } = await client.query("select 1 from public.invoice_line where source_doc_id = $1", [doc.name]);
    expect(lines).toHaveLength(0);
    const q = await quarantine(doc.name!);
    expect(q).toMatchObject({ reason_code: "PROCESSING_FAILED", status: "open", source_version: "1|2026-10-17 20:39:08.378782", has_candidate: true });
    expect(q.detail).toContain("kept failing");
    expect(q.detail).toContain("1|2026-10-18 10:00:00.000000");
  });

  it("leaves the figures alone when the failed message is older than the stored version", async () => {
    const doc = testDocs()[0]!;
    const current = withVersion(doc, 1, "2026-10-18 10:00:00.000000");
    expect(await apply(client, outcomeOf(current, mv), 0)).toBe("valid");
    const msgId = await send(client, recordMessage(withVersion(doc, 1, "2026-10-17 09:00:00.000000")));
    expect(await deadLetter(msgId)).toBe("moved");
    expect(await invoiceCount(doc.name!)).toBe(1);
    expect(await quarantine(doc.name!)).toBeUndefined();
  });

  it("fails closed for a message without a version (e.g. revalidate)", async () => {
    const doc = testDocs()[0]!;
    expect(await apply(client, outcomeOf(doc, mv), 0)).toBe("valid");
    const msgId = await send(client, { v: 1, kind: "revalidate", source: "erpnext", sourceDocId: doc.name });
    expect(await deadLetter(msgId)).toBe("moved");
    expect(await invoiceCount(doc.name!)).toBe(0);
    expect(await quarantine(doc.name!)).toMatchObject({ reason_code: "PROCESSING_FAILED" });
  });

  it("reopens a resolved quarantine row as PROCESSING_FAILED", async () => {
    const doc = testDocs()[2]!;
    const broken = withVersion(doc, 1, "2026-10-18 09:00:00.000000");
    broken.base_net_total = 1;
    await apply(client, outcomeOf(broken, mv), 0);
    await apply(client, outcomeOf(withVersion(doc, 1, "2026-10-18 10:00:00.000000"), mv), 0);
    expect(await quarantine(doc.name!)).toMatchObject({ status: "resolved" });
    const msgId = await send(client, recordMessage(withVersion(doc, 1, "2026-10-18 11:00:00.000000")));
    await deadLetter(msgId);
    expect(await quarantine(doc.name!)).toMatchObject({ reason_code: "PROCESSING_FAILED", status: "open" });
  });

  it("returns 'missing' for a message that is no longer queued", async () => {
    expect(await deadLetter(-424242)).toBe("missing");
  });

  it("is reachable only by service_role", async () => {
    const { rows } = await client.query(
      `select has_function_privilege('service_role', 'public.dead_letter_message(bigint, text)', 'EXECUTE') as svc,
              has_function_privilege('anon', 'public.dead_letter_message(bigint, text)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.dead_letter_message(bigint, text)', 'EXECUTE') as auth,
              has_function_privilege('authenticated', 'internal.dead_letter(bigint, text)', 'EXECUTE') as internal_auth,
              has_function_privilege('anon', 'public.write_consumer_heartbeat(integer, interval, integer)', 'EXECUTE') as hb_anon`,
    );
    expect(rows[0]).toEqual({ svc: true, anon: false, auth: false, internal_auth: false, hb_anon: false });
    await client.query("savepoint s");
    await client.query("set local role authenticated");
    await expect(client.query("select public.dead_letter_message(1, 'x')")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await client.query("rollback to savepoint s");
  });
});
