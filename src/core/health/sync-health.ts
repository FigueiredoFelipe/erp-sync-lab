// The red-banner rules of the sync health page (PLAN "Dashboard, API and access": freshness is honest,
// a fresh poll time can never hide stale figures). Pure: the caller passes the readings and the clock.

export type HealthAlertCode =
  | "CONSUMER_NEVER_RAN"
  | "CONSUMER_STALE"
  | "QUEUE_BACKLOG"
  | "DEAD_LETTERS"
  | "PARKED_MESSAGES"
  | "RECONCILIATION_UNEXPLAINED";

export interface HealthAlert {
  code: HealthAlertCode;
  message: string;
}

export interface HealthReadings {
  // consumer_heartbeat.last_run_at (ISO), null when the consumer never ran.
  consumerLastRunAt: string | null;
  // Messages still in the queue past the attempt limit (until T13 moves them to the DLQ).
  parked: number;
  // Age of the oldest message waiting in invoice_events; null when unknown (metrics not available).
  oldestPendingAgeSeconds: number | null;
  // Rows in dead_letter plus anything still sitting in the DLQ queue.
  deadLetters: number;
  // `unexplained` of the latest reconciliation run; null when there is none (or not available yet).
  reconciliationUnexplained: number | null;
}

export const CONSUMER_STALE_AFTER_SECONDS = 5 * 60;
export const QUEUE_BACKLOG_AFTER_SECONDS = 10 * 60;

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export function syncHealthAlerts(readings: HealthReadings, now: Date): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  if (readings.consumerLastRunAt === null) {
    alerts.push({ code: "CONSUMER_NEVER_RAN", message: "The queue consumer has never run: nothing synced reaches the figures." });
  } else {
    const age = Math.floor((now.getTime() - new Date(readings.consumerLastRunAt).getTime()) / 1000);
    // Strictly older than 5 minutes.
    if (age > CONSUMER_STALE_AFTER_SECONDS) {
      alerts.push({ code: "CONSUMER_STALE", message: `The queue consumer last ran ${minutes(age)} ago (limit: 5 minutes); figures may be stale.` });
    }
  }

  if (readings.oldestPendingAgeSeconds !== null && readings.oldestPendingAgeSeconds > QUEUE_BACKLOG_AFTER_SECONDS) {
    alerts.push({
      code: "QUEUE_BACKLOG",
      message: `The oldest pending message has waited ${minutes(readings.oldestPendingAgeSeconds)} (limit: 10 minutes).`,
    });
  }

  if (readings.deadLetters > 0) {
    alerts.push({ code: "DEAD_LETTERS", message: `${readings.deadLetters} message(s) in the dead-letter queue need investigation.` });
  }

  if (readings.parked > 0) {
    alerts.push({ code: "PARKED_MESSAGES", message: `${readings.parked} message(s) failed 5 attempts and are parked in the queue.` });
  }

  if (readings.reconciliationUnexplained !== null && readings.reconciliationUnexplained > 0) {
    alerts.push({
      code: "RECONCILIATION_UNEXPLAINED",
      message: `The latest reconciliation found ${readings.reconciliationUnexplained} unexplained difference(s) with ERPNext.`,
    });
  }

  return alerts;
}
