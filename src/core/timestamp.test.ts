import { describe, expect, it } from "@jest/globals";
import { formatTimestamp } from "./timestamp.ts";

describe("formatTimestamp", () => {
  it("formats an ISO instant in New York time with the zone name", () => {
    expect(formatTimestamp("2026-10-18T19:12:01.977Z")).toBe("Oct 18, 2026, 3:12 PM EDT");
  });

  it("does not throw on the option set browsers reject when dateStyle is mixed with timeZoneName", () => {
    expect(() => formatTimestamp("2026-01-15T12:00:00Z")).not.toThrow();
  });
});
