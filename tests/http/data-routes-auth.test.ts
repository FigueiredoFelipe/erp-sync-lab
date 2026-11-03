import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { guarded, type Opened } from "../../src/http/access.ts";
import { jsonResponse } from "../../src/http/problem.ts";
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

// T22/T26 / AC10, AC24: every real data route is behind the access gate. openSession() is mocked, so these
// tests fail if a route stops wrapping its handler in guarded(openSession, ...). The forged-cookie tests at the
// end run the real openSession() (real @supabase/ssr client, cookies from a stubbed next/headers store).
const openSession = jest.fn<() => Promise<Opened<unknown>>>();
jest.mock("../../app/_lib/supabase.ts", () => ({ openSession: () => openSession() }));

type Cookie = { name: string; value: string; options?: unknown };
const cookieJar: { cookies: Cookie[]; set: jest.Mock<(name: string, value: string, options?: unknown) => void> } = {
  cookies: [],
  set: jest.fn(),
};
jest.mock("next/headers.js", () => ({
  cookies: async () => ({ getAll: () => cookieJar.cookies, set: (name: string, value: string, options?: unknown) => cookieJar.set(name, value, options) }),
}));
const realOpenSession = () =>
  jest.requireActual<typeof import("../../app/_lib/supabase.ts")>("../../app/_lib/supabase.ts").openSession();

const ROUTES = [
  ["/api/revenue/monthly", () => import("../../app/api/revenue/monthly/route.ts")],
  ["/api/revenue/customers", () => import("../../app/api/revenue/customers/route.ts")],
  ["/api/revenue/documents", () => import("../../app/api/revenue/documents/route.ts")],
  ["/api/quarantine", () => import("../../app/api/quarantine/route.ts")],
  ["/api/freshness", () => import("../../app/api/freshness/route.ts")],
] as const;

// A client every query on fails, so a test sees only what the gate decided.
const brokenClient = new Proxy({}, { get: () => { throw new Error("no database in this test"); } });

function session(user: unknown, allowed: unknown, userError: { name: string; status?: number; code?: string; message: string } | null = null) {
  const getUser = jest.fn(async () => ({ data: { user }, error: userError }));
  const isAllowlisted = jest.fn(async () => ({ data: allowed, error: null }));
  return { getUser, isAllowlisted, opened: { status: "open", session: { getUser, isAllowlisted, client: brokenClient } } as const };
}

beforeEach(() => {
  openSession.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(ROUTES)("GET %s", (path, load) => {
  const get = async () => (await load()).GET(new Request(`http://localhost:3000${path}`));

  it("answers 401 Problem Details without a session", async () => {
    openSession.mockResolvedValue({ status: "signed-out" });
    const response = await get();
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
  });

  it("answers 401 to a replayed signed-out session (AC24)", async () => {
    const s = session(null, true, { name: "AuthApiError", status: 403, code: "session_not_found", message: "session not found" });
    openSession.mockResolvedValue(s.opened);
    const response = await get();
    expect(response.status).toBe(401);
    expect(s.getUser).toHaveBeenCalled();
  });

  it("answers 403 Problem Details to an account off the allowlist", async () => {
    const s = session({ id: "u1" }, false);
    openSession.mockResolvedValue(s.opened);
    const response = await get();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ status: 403, title: "Forbidden" });
    expect(s.isAllowlisted).toHaveBeenCalled();
  });

  it("answers 500 Problem Details when the session can't be opened", async () => {
    openSession.mockRejectedValue(new Error("getClaims failed: down"));
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 500, title: "Internal Server Error" });
  });
});

// PLAN R17 point 1 (round 2): the session is opened by verifying the access token's signature, so a forged
// cookie is no session: 401 at once, no from/rpc, nothing logged.
describe("a forged auth cookie, through the real openSession()", () => {
  let keys: Keys;
  let forged: Array<[string, string]> = [];
  const env = { url: process.env["SUPABASE_URL"], key: process.env["SUPABASE_PUBLISHABLE_KEY"] };

  beforeAll(async () => {
    keys = await makeKeys();
    forged = await forgedTokens(keys);
    process.env["SUPABASE_URL"] = SUPABASE_URL;
    process.env["SUPABASE_PUBLISHABLE_KEY"] = PUBLISHABLE_KEY;
  });

  afterAll(() => {
    for (const [name, value] of [["SUPABASE_URL", env.url], ["SUPABASE_PUBLISHABLE_KEY", env.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    // auth-js warns on its own when a background refresh fails; only console.error is part of the contract.
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    openSession.mockImplementation(realOpenSession);
    cookieJar.cookies = [];
    cookieJar.set.mockReset();
  });

  it("the kit's own token opens a session, verified locally (the forged cases below are not vacuous)", async () => {
    const fetch = stubFetch(keys);
    cookieJar.cookies = [sessionCookie(await validToken(keys))];

    const opened = await realOpenSession();

    expect(opened.status).toBe("open");
    expect(fetch.urls.map((u) => new URL(u).pathname).filter((p) => p !== "/auth/v1/.well-known/jwks.json")).toEqual([]);
  });

  it("answers 401 without any auth cookie, asking nothing", async () => {
    const fetch = stubFetch(keys);
    const { GET } = await import("../../app/api/revenue/monthly/route.ts");
    expect((await GET(new Request("http://localhost:3000/api/revenue/monthly"))).status).toBe(401);
    expect(fetch.urls).toEqual([]);
  });

  it("covers the eight forged tokens of T26e", () => {
    expect(forged.map(([label]) => label)).toHaveLength(8);
  });

  describe.each(ROUTES)("GET %s", (path, load) => {
    it.each(Array.from({ length: 8 }, (_, i) => i))("forged token #%i -> 401, no from/rpc, no console.error", async (i) => {
      const [label, token] = forged[i]!;
      const fetch = stubFetch(keys);
      const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
      cookieJar.cookies = [sessionCookie(token)];

      const response = await (await load()).GET(new Request(`http://localhost:3000${path}`));

      expect({ label, status: response.status }).toEqual({ label, status: 401 });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(fetch.rest()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });
  });

  it("answers 500, not 401, when the key set can't be fetched (an outage is never a sign-out)", async () => {
    const fresh = await makeKeys(`kid-${Date.now()}`);
    const fetch = stubFetch(fresh, { jwks: { status: 404, body: { message: "not found" } } });
    cookieJar.cookies = [sessionCookie(await validToken(fresh))];
    const { GET } = await import("../../app/api/freshness/route.ts");

    const response = await GET(new Request("http://localhost:3000/api/freshness"));

    expect(response.status).toBe(500);
    expect(fetch.rest()).toEqual([]);
  });

  // 429 rather than 5xx: auth-js retries a 5xx refresh with backoff for about half a minute before giving up.
  it("answers 500 when Auth rate-limits the refresh", async () => {
    stubFetch(keys, { token: async () => ({ status: 429, body: { error_code: "over_request_rate_limit", msg: "slow down" } }) });
    cookieJar.cookies = [sessionCookie(await validToken(keys), nowSeconds() - 60)];
    const { GET } = await import("../../app/api/freshness/route.ts");

    expect((await GET(new Request("http://localhost:3000/api/freshness"))).status).toBe(500);
  });

  it("answers 401 when the refresh token is rejected", async () => {
    stubFetch(keys);
    cookieJar.cookies = [sessionCookie(await validToken(keys), nowSeconds() - 60)];
    const { GET } = await import("../../app/api/freshness/route.ts");

    expect((await GET(new Request("http://localhost:3000/api/freshness"))).status).toBe(401);
  });

  // PLAN R17 point 1: a coded 4xx from Auth is a sign-out, so a garbage refresh token is 401, not 500.
  it.each(ROUTES)("answers 401 to a malformed refresh token (Auth 400 validation_failed) on %s, no from/rpc", async (path, load) => {
    const fetch = stubFetch(keys, { token: async () => MALFORMED_REFRESH });
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    cookieJar.cookies = [await malformedRefreshCookie(keys)];

    const response = await (await load()).GET(new Request(`http://localhost:3000${path}`));

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetch.urls.map((u) => new URL(u).pathname)).toContain("/auth/v1/token");
    expect(fetch.rest()).toEqual([]);
    // auth-js logs the failed refresh itself (an AuthApiError object); the route logs nothing of its own.
    expect(error.mock.calls.filter(([first]) => typeof first === "string")).toEqual([]);
  });

  // app/_lib/supabase.ts setAll: the refreshed cookies are written; the cache headers @supabase/ssr passes
  // alongside them are not applied because every data response already carries no-store.
  it("writes the refreshed cookies and still answers no-store", async () => {
    stubFetch(keys, {
      token: () => refreshed(keys),
      user: { status: 200, body: { id: "u1", aud: "authenticated", role: "authenticated" } },
    });
    cookieJar.cookies = [sessionCookie(await validToken(keys), nowSeconds() - 60)];
    const GET = guarded(realOpenSession, () => async () => jsonResponse({ ok: true }));

    const response = await GET(new Request("http://localhost:3000/api/freshness"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cookieJar.set.mock.calls.map(([name]) => name)).toContain(COOKIE_NAME);
  });
});

// The browser side of the same rule: a refused call leaves the page instead of rendering anything.
declare global {
  // Only what fetchJson uses; the root tsconfig has no DOM types.
  var window: { location: { assign(url: string): void } };
}

describe("fetchJson", () => {
  const assign = jest.fn<(url: string) => void>();

  beforeEach(() => {
    assign.mockReset();
    globalThis.window = { location: { assign } };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  const respond = (status: number, body: unknown) =>
    jest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );

  it.each([
    [401, "/login"],
    [403, "/denied"],
  ])("on %s goes to %s and never settles", async (status, target) => {
    const { fetchJson } = await import("../../app/_components/fetch-json.ts");
    respond(status, { status, detail: "refused" });

    let settled = false;
    fetchJson("/api/revenue/monthly").then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(assign).toHaveBeenCalledWith(target);
    expect(settled).toBe(false);
  });

  it("returns the body on 200 without leaving the page", async () => {
    const { fetchJson } = await import("../../app/_components/fetch-json.ts");
    respond(200, { months: [] });

    expect(await fetchJson("/api/revenue/monthly")).toEqual({ months: [] });
    expect(assign).not.toHaveBeenCalled();
  });

  it("rejects with ApiError on 500 without leaving the page", async () => {
    const { ApiError, fetchJson } = await import("../../app/_components/fetch-json.ts");
    respond(500, { status: 500, detail: "boom" });

    await expect(fetchJson("/api/revenue/monthly")).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });
});
