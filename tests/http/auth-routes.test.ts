import { describe, expect, it, jest } from "@jest/globals";
import * as callbackRoute from "../../app/auth/callback/route.ts";
import * as loginRoute from "../../app/auth/login/route.ts";
import * as logoutRoute from "../../app/auth/logout/route.ts";
import { createCallbackHandler, createLoginHandler, createLogoutHandler, type AuthApi } from "../../src/http/auth-handler.ts";

// T22: /auth/login, /auth/callback, /auth/logout over a fake Supabase auth client.
const ORIGIN = "https://dashboard.example";

function fakeAuth(overrides: Partial<AuthApi> = {}) {
  const auth: AuthApi = {
    signInWithOAuth: jest.fn(async () => ({ data: { url: "https://accounts.google.com/o/oauth2/auth?x=1" }, error: null })),
    exchangeCodeForSession: jest.fn(async () => ({ error: null })),
    signOut: jest.fn(async () => ({ error: null })),
    ...overrides,
  };
  return { auth, getAuth: async () => auth };
}

const quiet = () => jest.spyOn(console, "error").mockImplementation(() => undefined);

const ROUTES = [
  ["/auth/login", loginRoute, "POST"],
  ["/auth/logout", logoutRoute, "POST"],
  ["/auth/callback", callbackRoute, "GET"],
] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

describe.each(ROUTES)("%s", (path, route, allowed) => {
  it.each(METHODS.filter((method) => method !== allowed))("answers 405 Problem Details to %s", async (method) => {
    const handler = (route as unknown as Record<string, (request: Request) => Response | Promise<Response>>)[method]!;

    const response = await handler(new Request(`${ORIGIN}${path}`, { method }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allowed);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: 405, title: "Method Not Allowed" });
  });
});

describe("redirects", () => {
  // They carry session cookies, so no cache may keep or replay them (PLAN R17 point 4).
  it.each([
    ["POST /auth/login", () => createLoginHandler(fakeAuth().getAuth)(new Request(`${ORIGIN}/auth/login`, { method: "POST" }))],
    [
      "POST /auth/login when the flow can't start",
      () =>
        createLoginHandler(async () => ({ ...fakeAuth().auth, signInWithOAuth: async () => ({ data: { url: null }, error: { message: "x" } }) }))(
          new Request(`${ORIGIN}/auth/login`, { method: "POST" }),
        ),
    ],
    ["GET /auth/callback", () => createCallbackHandler(fakeAuth().getAuth)(new Request(`${ORIGIN}/auth/callback?code=abc`))],
    ["GET /auth/callback without a code", () => createCallbackHandler(fakeAuth().getAuth)(new Request(`${ORIGIN}/auth/callback`))],
    ["POST /auth/logout", () => createLogoutHandler(fakeAuth().getAuth)(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }))],
  ])("%s answers 303 with Cache-Control: no-store", async (_label, run) => {
    quiet();
    const response = await run();
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /auth/login", () => {
  it("sends the browser to Google with a callback on the same origin", async () => {
    const { auth, getAuth } = fakeAuth();

    const response = await createLoginHandler(getAuth)(new Request(`${ORIGIN}/auth/login`, { method: "POST" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: `${ORIGIN}/auth/callback` } });
  });

  it("returns to /login with an error when Supabase can't start the flow", async () => {
    quiet();
    const { getAuth } = fakeAuth({ signInWithOAuth: async () => ({ data: { url: null }, error: { message: "provider disabled" } }) });

    const response = await createLoginHandler(getAuth)(new Request(`${ORIGIN}/auth/login`, { method: "POST" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=start`);
  });

  it("answers 405 Problem Details to GET, with Allow: POST", async () => {
    const response = loginRoute.GET(new Request(`${ORIGIN}/auth/login`));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("GET /auth/callback", () => {
  it("exchanges the code and opens the dashboard", async () => {
    const { auth, getAuth } = fakeAuth();

    const response = await createCallbackHandler(getAuth)(new Request(`${ORIGIN}/auth/callback?code=abc`));

    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  it("returns to /login without a code, never creating a session", async () => {
    const { auth, getAuth } = fakeAuth();

    const response = await createCallbackHandler(getAuth)(new Request(`${ORIGIN}/auth/callback?error=access_denied`));

    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=callback`);
  });

  it("returns to /login when the code is rejected", async () => {
    quiet();
    const { getAuth } = fakeAuth({ exchangeCodeForSession: async () => ({ error: { message: "invalid flow state" } }) });

    const response = await createCallbackHandler(getAuth)(new Request(`${ORIGIN}/auth/callback?code=stale`));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login?error=callback`);
  });

  it("answers 405 to POST", async () => {
    expect(callbackRoute.POST(new Request(`${ORIGIN}/auth/callback`, { method: "POST" })).status).toBe(405);
  });
});

describe("POST /auth/logout", () => {
  it("ends the session and goes to /login", async () => {
    const { auth, getAuth } = fakeAuth();

    const response = await createLogoutHandler(getAuth)(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }));

    expect(auth.signOut).toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("still goes to /login when sign-out fails", async () => {
    quiet();
    const { getAuth } = fakeAuth({ signOut: async () => ({ error: { message: "network" } }) });

    const response = await createLogoutHandler(getAuth)(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
  });

  it("answers 405 to GET, so a link or prefetch can't sign anyone out", async () => {
    expect(logoutRoute.GET(new Request(`${ORIGIN}/auth/logout`)).status).toBe(405);
  });
});
