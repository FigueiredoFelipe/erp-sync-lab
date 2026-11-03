import { describe, expect, it } from "@jest/globals";
import { DEMO_PATH, demoRoute } from "./demo-mode.ts";

describe("demoRoute", () => {
  it.each(["/demo", "/", "/customers", "/api/freshness", "/auth/login"])("passes %s when demo mode is off", (path) => {
    expect(demoRoute(path, false)).toBe("pass");
  });

  it("passes the demo page itself in demo mode", () => {
    expect(demoRoute(DEMO_PATH, true)).toBe("pass");
  });

  it.each(["/", "/customers", "/health", "/quarantine", "/login", "/denied", "/anything-else"])(
    "sends %s to the demo in demo mode",
    (path) => expect(demoRoute(path, true)).toBe("to-demo"),
  );

  it.each(["/api/freshness", "/api/revenue/monthly", "/auth/login", "/auth/callback"])(
    "refuses %s in demo mode",
    (path) => expect(demoRoute(path, true)).toBe("not-found"),
  );
});
