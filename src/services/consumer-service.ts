// Queue consumer (PLAN "Queue, consumers and failures"). Runtime-agnostic: the Edge Function injects the
// RPC client, the clock and, only when ENABLE_TEST_SWITCHES is set, the test-switch lookup.
// Per message: begin_attempt -> parse -> adapter -> validate -> apply_record (applies and deletes the message
// in one transaction). A webhook hint is first resolved to the current ERPNext document (resolveHint). Any error leaves the message in the queue with exponential backoff; the 5th failed
// attempt (Q4) moves it to the dead-letter queue instead (R13).

import type { CanonicalCandidate, ReasonCode } from "../core/canonical.ts";
import { toCandidate } from "../core/adapters/erpnext/adapter.ts";
import { centsToDecimal } from "../core/money.ts";
import { buildCustomerIndex, type CustomerAlias, type CustomerIndex } from "../core/customers/resolve.ts";
import { SourceUnavailableError } from "../core/sync/contracts.ts";
import { defaultValidationConfig, validate, type ValidationConfig } from "../core/validation/validate.ts";
import type { HintResolution } from "./webhook-service.ts";
import {
  isObject,
  parseCandidate,
  parseMessage,
  type HintMessage,
  type QueueEvent,
  type RecordMessage,
  type RevalidateMessage,
  type TombstoneMessage,
} from "./queue-messages.ts";

export { MalformedMessageError, parseMessage } from "./queue-messages.ts";
export type { RecordMessage } from "./queue-messages.ts";

export type RpcError = { message: string };
export type RpcResult = { data: unknown; error: RpcError | null };

// The shape of supabase-js `rpc`, so the service runs on the real client and on fakes alike.
export type RpcClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
};

export type ConsumerDeps = {
  rpc: RpcClient;
  now?: () => Date;
  // Present only when test switches are enabled; absent means every switch is off.
  testSwitch?: (name: string) => Promise<boolean>;
  validationConfig?: ValidationConfig;
  // Loads the customer mapping once per non-empty batch; defaults to the load_customer_index RPC.
  loadCustomers?: () => Promise<CustomerIndex>;
  // Fetches the current ERPNext document for a webhook hint (webhookService.resolveHint). Absent: a hint
  // fails like any other error, so a misconfigured function shows up in the DLQ instead of dropping silently.
  resolveHint?: (name: string) => Promise<HintResolution>;
};

export type QueueMessage = { msg_id: number; read_ct: number; enqueued_at: string; message: unknown };

export type Outcome = {
  // cancelled: BR01 (an ERPNext cancellation or tombstone); removed: BR10 (a Source B tombstone).
  kind: "valid" | "invalid" | "cancelled" | "removed";
  source: CanonicalCandidate["source"];
  sourceDocId: string;
  sourceVersion: string;
  reasonCode?: ReasonCode;
  detail?: string;
  candidate: CanonicalCandidate | null; // null only for a tombstone
  // The mapping the verdict was computed with; apply_record refuses it if the mapping changed since (BR05).
  mappingVersion: number;
  canonicalCustomerId: string | null;
};

export type AppliedOutcome = Outcome["kind"] | "stale";

export type BatchResult = {
  read: number;
  valid: number;
  invalid: number;
  cancelled: number;
  removed: number;
  stale: number;
  // Acknowledged without an apply: revalidate messages whose record is gone (tombstoned, or only a
  // PROCESSING_FAILED row), and webhook hints dropped (draft, other company, deleted, ERPNext unavailable).
  skipped: number;
  failed: number;
  // Moved to the dead-letter queue this run (R13): the 5th attempt failed, or a message came back past it.
  deadLettered: number;
};

export const BATCH_SIZE = 10; // constitution "Runtime limits"
export const VISIBILITY_TIMEOUT_S = 180; // longer than the 150 s wall-clock limit
export const MAX_ATTEMPTS = 5; // Q4
export const BACKOFF_BASE_S = 30;
export const BACKOFF_CAP_S = 900;
// Hints only start fetching from ERPNext within this part of the run; later ones are dropped, so a slow
// ERPNext can't push the batch past the 150 s wall-clock limit (each fetch is bounded by ERP_HTTP_LIMITS).
export const HINT_BUDGET_MS = 60_000;
export const THROW_AFTER_3_SWITCH = "consumer_throw_after_3";

// Thrown on purpose by the AC03 test switch: it stands for the function dying mid-batch.
export class TestSwitchCrash extends Error {
  constructor() {
    super(`Test switch ${THROW_AFTER_3_SWITCH}: crashing after the 3rd message`);
    this.name = "TestSwitchCrash";
  }
}

// The whole batch can't run (the customer mapping can't be loaded or is ambiguous).
export class ConsumerBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumerBlockedError";
  }
}

// 30 s × 2^(attempts − 1), capped at 15 minutes.
export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** Math.min(exponent, 30));
}

export async function processBatch(deps: ConsumerDeps): Promise<BatchResult> {
  const now = deps.now ?? (() => new Date());
  const config = deps.validationConfig ?? defaultValidationConfig;
  const throwAfter3 = deps.testSwitch ? await deps.testSwitch(THROW_AFTER_3_SWITCH) : false;

  const messages = (await call(deps.rpc, "read_invoice_events", { p_vt: VISIBILITY_TIMEOUT_S, p_qty: BATCH_SIZE })) as
    | QueueMessage[]
    | null;
  const batch = messages ?? [];
  const readAt = now();
  let customers: CustomerIndex | null = null;
  if (batch.length > 0) {
    try {
      customers = await (deps.loadCustomers ?? (() => loadCustomerIndex(deps.rpc)))();
    } catch (error) {
      // Nothing can be validated without the mapping (e.g. an ambiguous one, CustomerMappingError). Every batch
      // would stop here, so make it loud: a heartbeat showing nothing processed and the backlog's age, then an
      // error the handler returns as 500 Problem Details. Messages stay queued; no attempt is counted.
      const reason = error instanceof Error ? error.message : String(error);
      await call(deps.rpc, "write_consumer_heartbeat", { p_processed: 0, p_oldest_message_age: oldestAge(batch, readAt), p_dead_lettered: 0 });
      throw new ConsumerBlockedError(`customer mapping unusable, no message processed: ${reason}`);
    }
  }

  const result: BatchResult = { read: batch.length, valid: 0, invalid: 0, cancelled: 0, removed: 0, stale: 0, skipped: 0, failed: 0, deadLettered: 0 };
  let started = 0;
  // Once ERPNext is unavailable in this run, the remaining hints are dropped without calling it again.
  let erpUnavailable = false;

  for (const msg of batch) {
    // AC03: the function "dies" here; the rest reappear after the visibility timeout.
    if (throwAfter3 && started === 3) throw new TestSwitchCrash();
    started++;

    let attempts: number | null = null;
    try {
      attempts = Number(await call(deps.rpc, "begin_attempt", { p_msg_id: msg.msg_id }));
      if (attempts > MAX_ATTEMPTS) {
        // Earlier attempts never reached the catch below (the run died), so this one gives up without trying.
        if (await deadLetter(deps.rpc, msg.msg_id, `exceeded ${MAX_ATTEMPTS} attempts without completing`)) result.deadLettered++;
        else await setVisibility(deps.rpc, msg.msg_id, BACKOFF_CAP_S);
        continue;
      }
      const event = parseMessage(msg.message);
      let outcome: Outcome | null;
      if (event.kind === "hint") {
        const canFetch = !erpUnavailable && now().getTime() - readAt.getTime() < HINT_BUDGET_MS;
        const resolved = canFetch ? await resolveHintMessage(deps, event) : null;
        if (resolved === "unavailable") erpUnavailable = true;
        outcome = resolved === null || resolved === "unavailable" ? null : decide(resolved, customers!, config);
      } else if (event.kind === "revalidate") {
        outcome = await revalidationOutcome(deps.rpc, event, customers!, config);
      } else {
        outcome = outcomeFor(event, customers!, config);
      }
      if (outcome === null) {
        await call(deps.rpc, "ack_invoice_event", { p_msg_id: msg.msg_id });
        result.skipped++;
        continue;
      }
      const applied = await call(deps.rpc, "apply_record", { p_outcome: outcome, p_msg_id: msg.msg_id });
      if (!isAppliedOutcome(applied)) throw new Error(`apply_record returned ${JSON.stringify(applied)}`);
      result[applied]++;
    } catch (error) {
      if (error instanceof TestSwitchCrash) throw error;
      result.failed++;
      const message = error instanceof Error ? error.message : String(error);
      if (attempts !== null && attempts >= MAX_ATTEMPTS && (await deadLetter(deps.rpc, msg.msg_id, message))) {
        result.deadLettered++;
      } else {
        await setVisibility(deps.rpc, msg.msg_id, backoffSeconds(attempts ?? msg.read_ct));
      }
    }
  }

  const processed = result.valid + result.invalid + result.cancelled + result.removed + result.stale + result.skipped;
  await call(deps.rpc, "write_consumer_heartbeat", {
    p_processed: processed,
    p_oldest_message_age: oldestAge(batch, readAt),
    // Stored as consumer_heartbeat.parked: messages this run moved to the DLQ.
    p_dead_lettered: result.deadLettered,
  });
  return result;
}

// PLAN "Source A: webhooks": a hint becomes the record message the poll would build for the document's
// current version. Best-effort: a draft, another company's invoice or a deleted document (null), and
// ERPNext being unavailable ("unavailable"), all drop the hint; polling is the backstop. Any other error
// (raw upload, unexpected ERPNext answer) propagates and is retried like any message.
export async function resolveHintMessage(deps: ConsumerDeps, hint: HintMessage): Promise<RecordMessage | null | "unavailable"> {
  if (!deps.resolveHint) throw new Error("hint received but no ERPNext hint resolver is configured");
  let resolution: HintResolution;
  try {
    resolution = await deps.resolveHint(hint.sourceDocId);
  } catch (error) {
    if (error instanceof SourceUnavailableError) return "unavailable";
    throw error;
  }
  if (resolution.outcome !== "record") return null;
  // Same strict checks as a polled record: the name must match and the version must be a submitted or cancelled one.
  const message = parseMessage(resolution.message);
  if (message.kind !== "record" || message.source !== "erpnext" || message.sourceDocId !== hint.sourceDocId) {
    throw new Error(`hint ${hint.sourceDocId} resolved to another record`);
  }
  return message;
}

// The outcome a message asks apply_record for. Records are validated; tombstones need no validation.
export function outcomeFor(event: Exclude<QueueEvent, RevalidateMessage | HintMessage>, customers: CustomerIndex, config: ValidationConfig = defaultValidationConfig): Outcome {
  if (event.kind === "tombstone") return tombstoneOutcome(event, customers);
  if (event.source === "erpnext") return decide(event, customers, config);
  // Source B arrives already parsed by its adapter (legacy-ingest); validation is the same code (PLAN "Validation").
  return decideCandidate(event.candidate, customers, config);
}

// R15: the candidate stored with the invoice or the open quarantine row, validated again with the current
// mapping at the same version (apply_record re-applies an equal version). Null when nothing is stored.
export async function revalidationOutcome(
  rpc: RpcClient,
  event: RevalidateMessage,
  customers: CustomerIndex,
  config: ValidationConfig = defaultValidationConfig,
): Promise<Outcome | null> {
  const stored = await call(rpc, "load_stored_record", { p_source: event.source, p_source_doc_id: event.sourceDocId });
  if (stored === null) return null;
  if (!isObject(stored)) throw new Error(`load_stored_record returned ${JSON.stringify(stored)}`);
  const candidate = parseCandidate(stored["candidate"], { source: event.source, sourceDocId: event.sourceDocId });
  return decideCandidate(candidate, customers, config);
}

// EC12 (ERPNext cancel-then-delete) gives the cancelled outcome; BR10 (missing from the newest export) removed.
export function tombstoneOutcome(event: TombstoneMessage, customers: CustomerIndex): Outcome {
  return {
    kind: event.source === "erpnext" ? "cancelled" : "removed",
    source: event.source,
    sourceDocId: event.sourceDocId,
    sourceVersion: event.sourceVersion,
    candidate: null,
    mappingVersion: customers.mappingVersion,
    canonicalCustomerId: null,
  };
}

export function decide(message: RecordMessage, customers: CustomerIndex, config: ValidationConfig = defaultValidationConfig): Outcome {
  return decideCandidate(toCandidate(message.doc, message.rawRef), customers, config);
}

// Validation verdict for a candidate, stamped with the mapping version it was computed with.
export function decideCandidate(candidate: CanonicalCandidate, customers: CustomerIndex, config: ValidationConfig = defaultValidationConfig): Outcome {
  const verdict = validate(candidate, customers, config);
  const base = {
    source: candidate.source,
    sourceDocId: candidate.sourceDocId,
    sourceVersion: candidate.sourceVersion,
    candidate,
    mappingVersion: customers.mappingVersion,
  };
  if (verdict.kind === "invalid") {
    return {
      ...base,
      kind: "invalid",
      reasonCode: verdict.reasonCode,
      detail: describeReason(verdict.reasonCode, candidate, config),
      canonicalCustomerId: null,
    };
  }
  if (verdict.kind === "valid") return { ...base, kind: "valid", canonicalCustomerId: verdict.canonicalCustomerId };
  return { ...base, kind: "cancelled", canonicalCustomerId: null };
}

// The customer mapping and its version, read in one statement so they always match.
export async function loadCustomerIndex(rpc: RpcClient): Promise<CustomerIndex> {
  const data = await call(rpc, "load_customer_index", {});
  if (!isObject(data) || typeof data["mappingVersion"] !== "number" || !Array.isArray(data["aliases"])) {
    throw new Error(`load_customer_index returned ${JSON.stringify(data)}`);
  }
  return buildCustomerIndex(data["mappingVersion"], data["aliases"] as CustomerAlias[]);
}

// Human-readable detail for the quarantine view (R09).
export function describeReason(code: ReasonCode, c: CanonicalCandidate, config: ValidationConfig = defaultValidationConfig): string {
  switch (code) {
    case "MISSING_FIELD":
      return "A required field is missing: customer, invoice date, currency, net total, or a complete line";
    case "INVALID_DATE":
      return `Invoice date is malformed or outside ${config.periodStart}..${config.periodEnd}: ${c.invoiceDate ?? "unparseable"}`;
    case "UNSUPPORTED_CURRENCY":
      return `Currency ${c.currency ?? "?"} is not USD`;
    case "CONFLICTING_DUPLICATE":
      return "Rows of this invoice disagree on customer, date, currency or total";
    case "UNKNOWN_CUSTOMER":
      return `Customer ${JSON.stringify(c.sourceCustomer)} is not in the customer mapping`;
    case "TOTAL_MISMATCH": {
      const linesCents = c.lines.reduce((sum, line) => sum + Math.round(line.netAmount * 100), 0);
      const total = c.netTotal === null ? "?" : centsToDecimal(Math.round(c.netTotal * 100));
      return `Net total ${total} differs from the sum of lines ${centsToDecimal(linesCents)}`;
    }
    default:
      return code;
  }
}

async function call(rpc: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

// Moves the message to the DLQ (internal.dead_letter). False when it was already gone or the move failed;
// a failed move leaves the message to come back and be moved on a later run.
async function deadLetter(rpc: RpcClient, msgId: number, error: string): Promise<boolean> {
  try {
    return (await call(rpc, "dead_letter_message", { p_msg_id: msgId, p_error: error.slice(0, 2000) })) === "moved";
  } catch {
    return false;
  }
}

// Best effort: if this fails too, the message still reappears when its 180 s visibility runs out.
async function setVisibility(rpc: RpcClient, msgId: number, seconds: number): Promise<void> {
  try {
    await call(rpc, "set_invoice_event_vt", { p_msg_id: msgId, p_seconds: seconds });
  } catch {
    // intentionally ignored
  }
}

// Age of the oldest message read in this batch, as a Postgres interval; null when the batch is empty.
function oldestAge(batch: QueueMessage[], readAt: Date): string | null {
  if (batch.length === 0) return null;
  const oldest = Math.min(...batch.map((m) => new Date(m.enqueued_at).getTime()));
  const seconds = Math.max(0, (readAt.getTime() - oldest) / 1000);
  return `${seconds.toFixed(3)} seconds`;
}

function isAppliedOutcome(value: unknown): value is AppliedOutcome {
  return value === "valid" || value === "invalid" || value === "cancelled" || value === "removed" || value === "stale";
}

