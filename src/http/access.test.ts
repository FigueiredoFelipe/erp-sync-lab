import { describe, expect, it, jest } from "@jest/globals";
import {
  classifyClaims,
  decideAccess,
  guarded,
  isSignedOutError,
  openSessionWith,
  pageAccess,
  pageCheck,
  pageRedirect,
  type AuthError,
  type Opened,
  type Session,
} from "./access.ts";

// T22/T26: the access gate in front of every data route and page (AC10, AC24, PLAN R17).
const request = new Request("http://localhost:3000/api/revenue/monthly");
const quiet = () => jest.spyOn(console, "error").mockImplementation(() => undefined);

const MISSING: AuthError = { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" };
const REJECTED: AuthError = { name: "AuthApiError", status: 403, code: "session_not_found", message: "Session from session_id claim in JWT does not exist" };
const OUTAGES: Array<[string, AuthError]> = [
  ["unreachable", { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }],
  ["5xx", { name: "AuthApiError", status: 503, message: "down" }],
  ["429", { name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "slow down" }],
  ["no status", { name: "AuthUnknownError", message: "?" }],
];

const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
const failed = <T>(): PromiseSettledResult<T> => ({ status: "rejected", reason: new Error("network") });
const user = (u: unknown, error: AuthError | null = null) => ok({ data: { user: u }, error });
const allow = (data: unknown, error: string | null = null) => ok({ data, error: error ? { message: error } : null });

// Errors as auth-js builds them (lib/errors.ts): name, status and code.
const authError = (name: string, status: number | undefined, code?: string, message = name): AuthError => ({ name, status, code, message });

// One rule for getClaims() and getUser() (PLAN R17 point 1): sign-out is a missing session, an invalid JWT, or
// a coded AuthApiError on a 4xx that is not a rate limit or an outage; everything else is an outage.
const SIGNED_OUT: Array<[string, AuthError]> = [
  ["session missing", MISSING],
  ["invalid JWT (decode, exp, signature)", authError("AuthInvalidJwtError", 400, "invalid_jwt")],
  ["malformed refresh token: 400 validation_failed", authError("AuthApiError", 400, "validation_failed")],
  ["400 refresh_token_not_found", authError("AuthApiError", 400, "refresh_token_not_found")],
  ["400 refresh_token_already_used", authError("AuthApiError", 400, "refresh_token_already_used")],
  ["403 bad_jwt", authError("AuthApiError", 403, "bad_jwt")],
  ["403 session_not_found (signed out)", REJECTED],
  ["403 session_expired", authError("AuthApiError", 403, "session_expired")],
  ["403 user_not_found", authError("AuthApiError", 403, "user_not_found")],
  ["401 no_authorization", authError("AuthApiError", 401, "no_authorization")],
  ["400 bad_json", authError("AuthApiError", 400, "bad_json")],
  ["403 user_banned", authError("AuthApiError", 403, "user_banned")],
];
const AUTH_OUTAGES: Array<[string, AuthError]> = [
  ...OUTAGES,
  ["unreachable (retryable fetch)", authError("AuthRetryableFetchError", 0)],
  ["retryable 503", authError("AuthRetryableFetchError", 503)],
  ["coded 5xx", authError("AuthApiError", 500, "unexpected_failure")],
  ["429 without a code", authError("AuthApiError", 429)],
  ["over_email_send_rate_limit on a 4xx", authError("AuthApiError", 400, "over_email_send_rate_limit")],
  ["over_sms_send_rate_limit on a 4xx", authError("AuthApiError", 400, "over_sms_send_rate_limit")],
  ["request_timeout on a 4xx", authError("AuthApiError", 408, "request_timeout")],
  ["gateway 401 without a code (Invalid API key)", authError("AuthApiError", 401, undefined, "Invalid API key")],
  ["key-set fetch 404 without a code", authError("AuthApiError", 404)],
  ["400 without a code", authError("AuthApiError", 400)],
  ["409 refresh discarded", authError("AuthRefreshDiscardedError", 409)],
  ["unparseable response", authError("AuthUnknownError", undefined)],
  ["a sign-out code on a non-API error", authError("AuthUnknownError", 400, "bad_jwt")],
];

describe("isSignedOutError", () => {
  it.each(SIGNED_OUT)("is a sign-out: %s", (_label, error) => {
    expect(isSignedOutError(error)).toBe(true);
  });

  it.each(AUTH_OUTAGES)("is an outage: %s", (_label, error) => {
    expect(isSignedOutError(error)).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "AuthSessionMissingError"],
  ] as const)("is not a sign-out for %s", (_label, error) => {
    expect(isSignedOutError(error)).toBe(false);
  });
});

describe("classifyClaims", () => {
  it("is present with claims and no error", () => {
    expect(classifyClaims({ data: { claims: { sub: "u1" } }, error: null })).toBe("present");
  });

  it("is absent without a session and no error", () => {
    expect(classifyClaims({ data: null, error: null })).toBe("absent");
  });

  it.each(SIGNED_OUT)("is absent on a sign-out-class error (%s)", (_label, error) => {
    expect(classifyClaims({ data: null, error })).toBe("absent");
  });

  it.each(AUTH_OUTAGES)("throws on an outage (%s), never reporting it as a sign-out", (_label, error) => {
    expect(() => classifyClaims({ data: null, error })).toThrow("getClaims failed");
  });
});

describe("openSessionWith", () => {
  const ops = (getClaims: () => Promise<unknown>) => ({
    getClaims: getClaims as never,
    getUser: jest.fn(async () => ({ data: { user: { id: "u1" } }, error: null })),
    isAllowlisted: jest.fn(async () => ({ data: true, error: null })),
  });

  it("opens a session over the client when the claims are verified, without asking Auth or the allowlist yet", async () => {
    const o = ops(async () => ({ data: { claims: { sub: "u1" } }, error: null }));
    const opened = await openSessionWith(o, "user-client");
    expect(opened.status).toBe("open");
    expect(o.getUser).not.toHaveBeenCalled();
    expect(o.isAllowlisted).not.toHaveBeenCalled();
    if (opened.status !== "open") throw new Error("unreachable");
    expect(opened.session.client).toBe("user-client");
    await opened.session.getUser();
    await opened.session.isAllowlisted();
    expect(o.getUser).toHaveBeenCalledTimes(1);
    expect(o.isAllowlisted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no session", async () => ({ data: null, error: null })],
    ["a sign-out-class error", async () => ({ data: null, error: authError("AuthInvalidJwtError", 400, "invalid_jwt") })],
    ["a thrown SyntaxError (header is not JSON)", async () => Promise.reject(new SyntaxError("Unexpected token"))],
    ["a thrown Error (alg none)", async () => Promise.reject(new Error("Invalid alg claim"))],
    ["a thrown DOMException (key of another type)", async () => Promise.reject(new DOMException("bad key", "DataError"))],
    ["a thrown sign-out-class Auth error", async () => Promise.reject(Object.assign(new Error("x"), { __isAuthError: true, name: "AuthSessionMissingError" }))],
  ])("is signed-out on %s, asking nothing else", async (_label, getClaims) => {
    const o = ops(getClaims);
    expect(await openSessionWith(o, null)).toEqual({ status: "signed-out" });
    expect(o.getUser).not.toHaveBeenCalled();
    expect(o.isAllowlisted).not.toHaveBeenCalled();
  });

  it.each([
    ["a returned outage", async () => ({ data: null, error: authError("AuthRetryableFetchError", 503) })],
    ["a thrown Auth outage", async () => Promise.reject(Object.assign(new Error("down"), { __isAuthError: true, name: "AuthRetryableFetchError", status: 0 }))],
  ])("throws on %s", async (_label, getClaims) => {
    await expect(openSessionWith(ops(getClaims), null)).rejects.toThrow("getClaims failed");
  });
});

describe("pageCheck", () => {
  it.each([
    ["/", "document", "full"],
    ["/customers", "document", "full"],
    ["/customers", null, "full"],
    ["/customers", "empty", "local"],
    ["/", "iframe", "local"],
    ["/login", "empty", "full"],
    ["/login", null, "full"],
    ["/denied", "empty", "full"],
    ["/denied", "document", "full"],
  ] as const)("%s with Sec-Fetch-Dest %s -> %s", (path, dest, expected) => {
    expect(pageCheck(path, dest)).toBe(expected);
  });
});

describe("decideAccess", () => {
  const SIGNED_IN = { id: "u1" };
  it.each([
    // getUser outage beats everything
    ["getUser rejected", failed(), allow(true), "error"],
    ["getUser rejected, allowlist rejected", failed(), failed(), "error"],
    ...AUTH_OUTAGES.map(([label, error]) => [`getUser ${label}`, user(null, error), allow(true), "error"] as const),
    ...SIGNED_OUT.map(([label, error]) => [`getUser ${label}`, user(null, error), allow(true), "signed-out"] as const),
    // no user beats anything app_access said, including its errors
    ["no user, allowlist true", user(null), allow(true), "signed-out"],
    ["no user, allowlist false", user(null), allow(false), "signed-out"],
    ["no user, allowlist error", user(null), allow(null, "permission denied"), "signed-out"],
    ["no user, allowlist rejected", user(null), failed(), "signed-out"],
    ["session missing, allowlist true", user(null, MISSING), allow(true), "signed-out"],
    ["session rejected (AC24 replay), allowlist true", user(null, REJECTED), allow(true), "signed-out"],
    ["sign-out error with a user, allowlist true", user(SIGNED_IN, REJECTED), allow(true), "signed-out"],
    // then the allowlist
    ["user, allowlist rejected", user(SIGNED_IN), failed(), "error"],
    ["user, allowlist error", user(SIGNED_IN), allow(true, "permission denied"), "error"],
    ["user, allowlist false", user(SIGNED_IN), allow(false), "denied"],
    ["user, allowlist null", user(SIGNED_IN), allow(null), "denied"],
    ["user, allowlist \"true\"", user(SIGNED_IN), allow("true"), "denied"],
    ["user, allowlist 1", user(SIGNED_IN), allow(1), "denied"],
    ["user, allowlist true", user(SIGNED_IN), allow(true), "allowed"],
  ] as const)("%s -> %s", (_label, u, a, expected) => {
    expect(decideAccess(u as never, a as never)).toBe(expected);
  });
});

describe("pageRedirect", () => {
  it.each([
    ["/", "signed-out", "/login"],
    ["/customers", "signed-out", "/login"],
    ["/denied", "signed-out", "/login"],
    ["/login", "signed-out", null],
    ["/", "denied", "/denied"],
    ["/health", "denied", "/denied"],
    ["/login", "denied", "/denied"],
    ["/denied", "denied", null],
    ["/", "allowed", null],
    ["/quarantine", "allowed", null],
    ["/login", "allowed", "/"],
    ["/denied", "allowed", "/"],
  ] as const)("%s as %s -> %s", (path, decision, expected) => {
    expect(pageRedirect(path, decision)).toBe(expected);
  });
});

type Stub = {
  getUser: jest.Mock<Session<string>["getUser"]>;
  isAllowlisted: jest.Mock<Session<string>["isAllowlisted"]>;
};

function stubSession(
  u: unknown,
  options: { userError?: AuthError; allowed?: unknown; accessError?: string; throws?: "getUser" | "isAllowlisted" } = {},
): Stub & { open: () => Promise<Opened<string>> } {
  const getUser = jest.fn<Session<string>["getUser"]>(async () => {
    if (options.throws === "getUser") throw new Error("auth down");
    return { data: { user: u }, error: options.userError ?? null };
  });
  const isAllowlisted = jest.fn<Session<string>["isAllowlisted"]>(async () => {
    if (options.throws === "isAllowlisted") throw new Error("db down");
    return { data: options.allowed ?? null, error: options.accessError ? { message: options.accessError } : null };
  });
  return {
    getUser,
    isAllowlisted,
    open: async () => ({ status: "open", session: { getUser, isAllowlisted, client: "user-client" } }),
  };
}

describe("pageAccess", () => {
  it("is signed-out without a session", async () => {
    expect(await pageAccess(async () => ({ status: "signed-out" }))).toBe("signed-out");
  });

  it("asks Auth and the allowlist together, both issued before either answers", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const held = <T>(name: string, value: T) =>
      new Promise<T>((resolve) => {
        started.push(name);
        releases.push(() => resolve(value));
      });
    let settled = false;
    const decision = pageAccess<null>(async () => ({
      status: "open",
      session: {
        getUser: () => held("getUser", { data: { user: { id: "u1" } }, error: null }),
        isAllowlisted: () => held("app_access", { data: true, error: null }),
        client: null,
      },
    })).finally(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.sort()).toEqual(["app_access", "getUser"]);
    expect(settled).toBe(false);
    for (const release of releases) release();
    expect(await decision).toBe("allowed");
  });

  it.each([
    ["allowed", stubSession({ id: "u1" }, { allowed: true })],
    ["denied", stubSession({ id: "u1" }, { allowed: false })],
    ["signed-out", stubSession(null, { userError: REJECTED, allowed: true })],
  ] as const)("is %s from the parallel check", async (expected, s) => {
    expect(await pageAccess(s.open)).toBe(expected);
  });

  it.each([
    ["getUser reports an outage", stubSession(null, { userError: OUTAGES[1]![1] })],
    ["getUser throws", stubSession(null, { throws: "getUser" })],
    ["the allowlist fails", stubSession({ id: "u1" }, { accessError: "permission denied" })],
    ["the allowlist throws", stubSession({ id: "u1" }, { throws: "isAllowlisted" })],
  ])("throws when %s, so the page fails", async (_label, s) => {
    await expect(pageAccess(s.open)).rejects.toThrow("Checking page access failed");
  });

  it("throws when opening the session throws", async () => {
    await expect(pageAccess(async () => Promise.reject(new Error("getClaims failed")))).rejects.toThrow("getClaims failed");
  });
});

const DATA = { secret: "rows the caller must not see" };

function routeWith(open: () => Promise<Opened<string>>, handler?: (request: Request) => Promise<Response>) {
  const run = jest.fn(
    handler ??
      (async (_request: Request) =>
        new Response(JSON.stringify(DATA), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } })),
  );
  const handlerFor = jest.fn((_client: string) => run);
  let now = 1000;
  const clock = () => (now += 12.34);
  return { GET: guarded(open, handlerFor, clock), run, handlerFor };
}

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("server-timing")).toBeNull();
  const text = await response.text();
  expect(text).not.toContain(DATA.secret);
  expect(JSON.parse(text)).toMatchObject({ type: "about:blank", status });
}

describe("guarded", () => {
  it("answers 500 when opening the session throws, and never starts the handler", async () => {
    quiet();
    const { GET, handlerFor } = routeWith(async () => {
      throw new Error("getClaims failed: down");
    });

    await expectProblem(await GET(request), 500);
    expect(handlerFor).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and starts no query at all", async () => {
    const { GET, handlerFor } = routeWith(async () => ({ status: "signed-out" }));

    const response = await GET(request);

    await expectProblem(response, 401);
    expect(handlerFor).not.toHaveBeenCalled();
  });

  it("starts Auth, the allowlist and the handler together, before any of them settles", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const pending = <T>(name: string, value: T) =>
      new Promise<T>((resolve) => {
        started.push(name);
        releases.push(() => resolve(value));
      });
    const GET = guarded<string>(
      async () => ({
        status: "open",
        session: {
          getUser: () => pending("getUser", { data: { user: { id: "u1" } }, error: null }),
          isAllowlisted: () => pending("app_access", { data: true, error: null }),
          client: "user-client",
        },
      }),
      () => () => pending("handler", new Response("{}", { status: 200 })),
    );

    const response = GET(request);
    await new Promise((resolve) => setImmediate(resolve));
    expect(started.sort()).toEqual(["app_access", "getUser", "handler"]);
    for (const release of releases) release();
    expect((await response).status).toBe(200);
  });

  it("answers 401 to a replayed signed-out session (AC24) without the handler's data", async () => {
    const s = stubSession(null, { userError: REJECTED, allowed: true });
    const { GET, run } = routeWith(s.open);

    await expectProblem(await GET(request), 401);
    expect(run).toHaveBeenCalled();
  });

  it("answers 403 to an account off the allowlist without the handler's data", async () => {
    const { GET } = routeWith(stubSession({ id: "u1" }, { allowed: false }).open);

    const response = await GET(request);

    await expectProblem(response, 403);
  });

  it("answers 401, not 500, to an anonymous caller whose handler rejects", async () => {
    const { GET } = routeWith(stubSession(null, { userError: MISSING, allowed: false }).open, async () => {
      throw new Error("permission denied for view");
    });

    await expectProblem(await GET(request), 401);
  });

  it("answers 401, not the handler's status, when the handler answered 400", async () => {
    const { GET } = routeWith(stubSession(null, { userError: MISSING }).open, async () =>
      new Response(JSON.stringify({ status: 400 }), { status: 400 }),
    );

    await expectProblem(await GET(request), 401);
  });

  it("answers 403 even when the handler threw synchronously", async () => {
    const s = stubSession({ id: "u1" }, { allowed: false });
    const GET = guarded(s.open, () => () => {
      throw new Error("sync");
    });

    await expectProblem(await GET(request), 403);
  });

  it.each([
    ["getUser reports an outage", stubSession(null, { userError: OUTAGES[0]![1], allowed: true })],
    ["getUser throws", stubSession({ id: "u1" }, { throws: "getUser", allowed: true })],
    ["the allowlist fails", stubSession({ id: "u1" }, { accessError: "permission denied" })],
    ["the allowlist throws", stubSession({ id: "u1" }, { throws: "isAllowlisted" })],
  ])("answers 500 when %s, without the handler's data", async (_label, s) => {
    quiet();
    const { GET } = routeWith(s.open);

    await expectProblem(await GET(request), 500);
  });

  it("returns the handler's response over the caller's own client when allowed, with Server-Timing", async () => {
    const original = new Response(JSON.stringify(DATA), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-extra": "kept" },
    });
    const { GET, run, handlerFor } = routeWith(stubSession({ id: "u1" }, { allowed: true }).open, async () => original);

    const response = await GET(request);

    expect(handlerFor).toHaveBeenCalledWith("user-client");
    expect(run).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DATA);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-extra")).toBe("kept");
    expect(response.headers.get("server-timing")).toBe("app;dur=12.3");
    expect(original.headers.get("server-timing")).toBeNull();
  });

  it("adds Server-Timing to the handler's own 400 when allowed", async () => {
    const { GET } = routeWith(stubSession({ id: "u1" }, { allowed: true }).open, async () =>
      new Response(JSON.stringify({ status: 400 }), { status: 400, headers: { "content-type": "application/problem+json" } }),
    );

    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(response.headers.get("server-timing")).toBe("app;dur=12.3");
  });

  it("answers 500 Problem Details with Server-Timing when the allowed handler rejects", async () => {
    quiet();
    const { GET } = routeWith(stubSession({ id: "u1" }, { allowed: true }).open, async () => {
      throw new Error("boom");
    });

    const response = await GET(request);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toBe("app;dur=12.3");
    expect(await response.json()).toMatchObject({ status: 500, title: "Internal Server Error" });
  });
});
