import { describe, expect, it } from "@jest/globals";
import { isSameRequest, pageReady, regionReady } from "../../app/_components/load-state.ts";

describe("regionReady", () => {
  it("is false while loading", () => {
    expect(regionReady({ state: "loading" })).toBe("false");
  });

  it("is true once the data arrived", () => {
    expect(regionReady({ state: "ok", data: [] } as { state: "ok"; data: unknown[] })).toBe("true");
  });

  it("is error when the load failed", () => {
    expect(regionReady({ state: "error", message: "boom" } as { state: "error"; message: string })).toBe("error");
  });
});

describe("pageReady", () => {
  it("is true when every region is ready", () => {
    expect(pageReady("true", "true")).toBe("true");
  });

  it("is false while any region loads", () => {
    expect(pageReady("true", "false")).toBe("false");
  });

  it("lets an error win over a region still loading", () => {
    expect(pageReady("false", "error", "true")).toBe("error");
    expect(pageReady("error", "false")).toBe("error");
  });

  it("ignores absent regions", () => {
    expect(pageReady("true", null)).toBe("true");
    expect(pageReady(null, "false")).toBe("false");
    expect(pageReady(null, "error")).toBe("error");
  });

  it("is true with no region on screen", () => {
    expect(pageReady()).toBe("true");
    expect(pageReady(null)).toBe("true");
  });
});

describe("isSameRequest", () => {
  it("is the same request when nothing changed and the last load did not fail", () => {
    expect(isSameRequest("from=2026-01", "from=2026-01", "ok")).toBe(true);
    expect(isSameRequest("from=2026-01", "from=2026-01", "loading")).toBe(true);
  });

  it("is a new request when the filters differ", () => {
    expect(isSameRequest("from=2026-02", "from=2026-01", "ok")).toBe(false);
    expect(isSameRequest("from=2026-02", "from=2026-01", "loading")).toBe(false);
  });

  it("treats the same filters after a failure as a retry", () => {
    expect(isSameRequest("from=2026-01", "from=2026-01", "error")).toBe(false);
  });
});
