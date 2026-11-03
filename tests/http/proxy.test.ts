import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest } from "next/server.js";
import {
  COOKIE_NAME,
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  MALFORMED_REFRESH,
  forgedTokens,
  makeKeys,
  malformedRefreshCookie,
  nowSeconds,
  refreshed,
  sessionCookie,
  stubFetch,
  validToken,
  type Keys,
} from "./session-kit.ts";

// T26e / PLAN R17 point 2: the proxy runs the real @supabase/ssr client over the request cookies; Auth and
// PostgREST are a fetch stub. A document load, a request without Sec-Fetch-Dest, /login and /denied get the
// full check (getUser + app_access); an in-app navigation (Sec-Fetch-Dest present, not "document") only the
// local one.
const env = { url: process.env["SUPABASE_URL"], key: process.env["SUPABASE_PUBLISHABLE_KEY"] };
let keys: Keys;

beforeAll(async () => {
  process.env["SUPABASE_URL"] = SUPABASE_URL;
  process.env["SUPABASE_PUBLISHABLE_KEY"] = PUBLISHABLE_KEY;
  keys = await makeKeys();
});

afterAll(() => {
  for (const [name, value] of [["SUPABASE_URL", env.url], ["SUPABASE_PUBLISHABLE_KEY", env.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const USER = { status: 200, body: { id: "u1", aud: "authenticated", role: "authenticated" } };
const DOCUMENT = "document";
const NAVIGATION = "empty";

function request(path: string, dest: string | null, cookie?: { name: string; value: string }) {
  const headers: Record<string, string> = {};
  if (dest !== null) headers["sec-fetch-dest"] = dest;
  if (cookie) headers["cookie"] = `${cookie.name}=${cookie.value}`;
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

async function run(req: NextRequest) {
  const { proxy } = await import("../../proxy.ts");
  return proxy(req);
}

const location = (response: Response) => {
  const to = response.headers.get("location");
  return to === null ? null : new URL(to).pathname;
};
const paths = (urls: string[]) => urls.map((u) => new URL(u).pathname);

describe("config", () => {
  it("matches the pages, /api and /auth (refused in demo mode), but not static files", async () => {
    const { config } = await import("../../proxy.ts");
    expect(config.matcher).toEqual(["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"]);
  });
});

describe("outside demo mode, /api, /auth and /demo pass through untouched", () => {
  it.each(["/api/freshness", "/auth/login", "/demo"])("passes %s without calling Auth", async (path) => {
    const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no network expected");
    });
    const response = await run(request(path, DOCUMENT));
    expect(location(response)).toBeNull();
    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("demo mode (DEMO_ONLY=true): no Supabase client is ever opened", () => {
  const saved = { url: "", key: "" };
  beforeEach(() => {
    process.env["DEMO_ONLY"] = "true";
    saved.url = process.env["SUPABASE_URL"] ?? "";
    saved.key = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? "";
    delete process.env["SUPABASE_URL"];
    delete process.env["SUPABASE_PUBLISHABLE_KEY"];
    jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no network expected");
    });
  });
  afterEach(() => {
    delete process.env["DEMO_ONLY"];
    process.env["SUPABASE_URL"] = saved.url;
    process.env["SUPABASE_PUBLISHABLE_KEY"] = saved.key;
  });

  it("serves /demo", async () => {
    const response = await run(request("/demo", DOCUMENT));
    expect(response.status).toBe(200);
    expect(location(response)).toBeNull();
  });

  it.each(["/", "/customers", "/health", "/quarantine", "/login", "/denied"])("sends %s to /demo", async (path) => {
    const response = await run(request(path, DOCUMENT));
    expect(location(response)).toBe("/demo");
  });

  it.each(["/api/freshness", "/auth/login"])("answers 404 to %s", async (path) => {
    const response = await run(request(path, DOCUMENT));
    expect(response.status).toBe(404);
  });
});

describe("full check (document load, no Sec-Fetch-Dest, /login, /denied)", () => {
  it.each([[DOCUMENT], [null]])("serves an allowlisted page (Sec-Fetch-Dest %s), asking Auth and the allowlist", async (dest) => {
    const fetch = stubFetch(keys, { user: USER });
    const response = await run(request("/customers", dest, sessionCookie(await validToken(keys))));
    expect(location(response)).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(paths(fetch.urls)).toEqual(expect.arrayContaining(["/auth/v1/user", "/rest/v1/rpc/app_access"]));
  });

  it("sends an account off the allowlist to /denied", async () => {
    stubFetch(keys, { user: USER, appAccess: { status: 200, body: false } });
    const response = await run(request("/", DOCUMENT, sessionCookie(await validToken(keys))));
    expect(location(response)).toBe("/denied");
  });

  it("sends a session Auth no longer knows (signed out) to /login", async () => {
    stubFetch(keys, { user: { status: 403, body: { error_code: "session_not_found", msg: "Session not found" } } });
    const response = await run(request("/", DOCUMENT, sessionCookie(await validToken(keys))));
    expect(location(response)).toBe("/login");
  });

  it("sends a visitor without a cookie to /login, asking nothing", async () => {
    const fetch = stubFetch(keys);
    const response = await run(request("/", DOCUMENT));
    expect(location(response)).toBe("/login");
    expect(fetch.urls).toEqual([]);
  });

  it.each([
    ["/login", "/"],
    ["/denied", "/"],
  ])("always checks %s in full, even on an in-app navigation (allowed -> %s)", async (path, to) => {
    const fetch = stubFetch(keys, { user: USER });
    const response = await run(request(path, NAVIGATION, sessionCookie(await validToken(keys))));
    expect(location(response)).toBe(to);
    expect(paths(fetch.urls)).toEqual(expect.arrayContaining(["/auth/v1/user", "/rest/v1/rpc/app_access"]));
  });

  it("fails the page on an allowlist outage instead of sending anyone to /login", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch(keys, { user: USER, appAccess: { status: 500, body: { message: "down" } } });
    await expect(run(request("/", DOCUMENT, sessionCookie(await validToken(keys))))).rejects.toThrow("Checking page access failed");
  });

  it("carries the refreshed cookies and the no-store headers onto the redirect", async () => {
    stubFetch(keys, { user: USER, token: () => refreshed(keys) });
    const response = await run(request("/login", DOCUMENT, sessionCookie(await validToken(keys), nowSeconds() - 60)));
    expect(location(response)).toBe("/");
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=base64-`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("expires")).not.toBeNull();
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  it("carries the refreshed cookies and no-store on a served page too", async () => {
    stubFetch(keys, { user: USER, token: () => refreshed(keys) });
    const response = await run(request("/", DOCUMENT, sessionCookie(await validToken(keys), nowSeconds() - 60)));
    expect(location(response)).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=base64-`);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("local check (in-app navigation or prefetch)", () => {
  it("serves the page shell to a valid session without asking Auth or the allowlist", async () => {
    // Off the allowlist on purpose: the local check doesn't ask, the data routes answer 403.
    const fetch = stubFetch(keys, { user: USER, appAccess: { status: 200, body: false } });
    const response = await run(request("/customers", NAVIGATION, sessionCookie(await validToken(keys))));
    expect(location(response)).toBeNull();
    expect(paths(fetch.urls).filter((p) => p !== "/auth/v1/.well-known/jwks.json")).toEqual([]);
  });

  it("sends a visitor without a cookie to /login", async () => {
    stubFetch(keys);
    expect(location(await run(request("/customers", NAVIGATION)))).toBe("/login");
  });
});

describe("a forged auth cookie", () => {
  it.each([[DOCUMENT], [NAVIGATION]])("goes to /login (Sec-Fetch-Dest %s), never asking PostgREST or logging an error", async (dest) => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const forged = await forgedTokens(keys);
    expect(forged).toHaveLength(8);
    for (const [label, token] of forged) {
      const fetch = stubFetch(keys);
      const response = await run(request("/", dest, sessionCookie(token)));
      expect({ label, to: location(response) }).toEqual({ label, to: "/login" });
      expect({ label, rest: fetch.rest() }).toEqual({ label, rest: [] });
      fetch.spy.mockRestore();
    }
    expect(error).not.toHaveBeenCalled();
  });
});

// PLAN R17 point 1: Auth answers a garbage refresh token with 400 validation_failed. That is a sign-out, not
// an outage: pages go to /login, /login itself renders, and the auth cookie is cleared on the way.
describe("a malformed refresh token", () => {
  const cleared = (response: Response) => {
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${COOKIE_NAME}=;`);
    expect(header.toLowerCase()).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
  };

  it.each([[DOCUMENT], [NAVIGATION]])("sends a page to /login (Sec-Fetch-Dest %s), clearing the auth cookie", async (dest) => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = stubFetch(keys, { token: async () => MALFORMED_REFRESH });
    const response = await run(request("/customers", dest, await malformedRefreshCookie(keys)));
    expect(location(response)).toBe("/login");
    expect(paths(fetch.urls)).toContain("/auth/v1/token");
    expect(fetch.rest()).toEqual([]);
    cleared(response);
    // auth-js logs the failed refresh itself (an AuthApiError object); the proxy logs nothing of its own.
    expect(error.mock.calls.filter(([first]) => typeof first === "string")).toEqual([]);
  });

  it("serves /login itself instead of failing it", async () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch(keys, { token: async () => MALFORMED_REFRESH });
    const response = await run(request("/login", DOCUMENT, await malformedRefreshCookie(keys)));
    expect(location(response)).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    cleared(response);
  });
});
