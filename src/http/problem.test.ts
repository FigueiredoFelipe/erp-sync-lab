import { describe, expect, it } from "@jest/globals";
import { jsonResponse, methodNotAllowed, problemResponse } from "./problem.ts";

// PLAN R17 point 4 / AC25: every Problem Details response carries Cache-Control: no-store, whatever the
// caller passes.
describe("problemResponse", () => {
  it("answers Problem Details with no-store", async () => {
    const response = problemResponse(401, "Sign in.");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ type: "about:blank", title: "Unauthorized", status: 401, detail: "Sign in." });
  });

  it.each([["cache-control"], ["Cache-Control"], ["CACHE-CONTROL"]])(
    "keeps no-store when the caller passes %s: public",
    (name) => {
      const response = problemResponse(500, "boom", { [name]: "public, max-age=3600" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("keeps the caller's other headers but not its content type", () => {
    const response = problemResponse(405, "no", { allow: "GET", "Content-Type": "text/html" });
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });

  it("405 carries Allow and no-store", () => {
    const response = methodNotAllowed(new Request("http://localhost/api/x", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("jsonResponse", () => {
  it("answers 200 JSON with no-store", async () => {
    const response = jsonResponse({ a: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ a: 1 });
  });
});
