import { describe, expect, it } from "@jest/globals";
import { syncHealthAlerts, type HealthReadings } from "./sync-health.ts";

const NOW = new Date("2026-10-18T20:00:00Z");
const HEALTHY: HealthReadings = {
  consumerLastRunAt: "2026-10-18T19:59:10Z",
  parked: 0,
  oldestPendingAgeSeconds: 30,
  deadLetters: 0,
  reconciliationUnexplained: 0,
};
const codes = (readings: Partial<HealthReadings>) => syncHealthAlerts({ ...HEALTHY, ...readings }, NOW).map((a) => a.code);

describe("syncHealthAlerts (red banner rules)", () => {
  it("is quiet when everything is healthy", () => {
    expect(codes({})).toEqual([]);
  });

  it("flags a consumer heartbeat older than 5 minutes, not at exactly 5", () => {
    expect(codes({ consumerLastRunAt: "2026-10-18T19:55:00Z" })).toEqual([]);
    expect(codes({ consumerLastRunAt: "2026-10-18T19:54:59Z" })).toEqual(["CONSUMER_STALE"]);
  });

  it("flags a consumer that never ran", () => {
    expect(codes({ consumerLastRunAt: null })).toEqual(["CONSUMER_NEVER_RAN"]);
  });

  it("flags an oldest pending message older than 10 minutes, not at exactly 10", () => {
    expect(codes({ oldestPendingAgeSeconds: 600 })).toEqual([]);
    expect(codes({ oldestPendingAgeSeconds: 601 })).toEqual(["QUEUE_BACKLOG"]);
    expect(codes({ oldestPendingAgeSeconds: null })).toEqual([]);
  });

  it("flags a non-empty dead-letter queue and parked messages", () => {
    expect(codes({ deadLetters: 1 })).toEqual(["DEAD_LETTERS"]);
    expect(codes({ parked: 2 })).toEqual(["PARKED_MESSAGES"]);
  });

  it("flags unexplained reconciliation differences, not a missing run", () => {
    expect(codes({ reconciliationUnexplained: 3 })).toEqual(["RECONCILIATION_UNEXPLAINED"]);
    expect(codes({ reconciliationUnexplained: null })).toEqual([]);
  });

  it("reports every condition at once, with readable messages", () => {
    const alerts = syncHealthAlerts(
      { consumerLastRunAt: "2026-10-18T19:00:00Z", parked: 1, oldestPendingAgeSeconds: 3600, deadLetters: 2, reconciliationUnexplained: 1 },
      NOW,
    );
    expect(alerts.map((a) => a.code)).toEqual(["CONSUMER_STALE", "QUEUE_BACKLOG", "DEAD_LETTERS", "PARKED_MESSAGES", "RECONCILIATION_UNEXPLAINED"]);
    expect(alerts[0]?.message).toContain("60 minutes ago");
    expect(alerts[1]?.message).toContain("60 minutes");
  });
});
