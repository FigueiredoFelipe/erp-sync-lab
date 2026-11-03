// Real Supabase session cookies for tests that run the real @supabase/ssr client (T26e, PLAN R17 points 1–2):
// an ES256 key set like the project's, signed and forged access tokens, the auth cookie that carries them,
// and a fetch stub standing in for Auth and PostgREST that records every request.
import { jest } from "@jest/globals";
import type { webcrypto } from "node:crypto";

type CryptoKey = webcrypto.CryptoKey;
type JsonWebKey = webcrypto.JsonWebKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

export const SUPABASE_URL = "https://testref.supabase.co";
export const PUBLISHABLE_KEY = "sb_publishable_test";
export const COOKIE_NAME = "sb-testref-auth-token";
export const KID = "test-es256-kid";

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).toString("base64url");
const json = (value: unknown) => b64url(JSON.stringify(value));

export interface Keys {
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg: string; use: string };
}

export async function makeKeys(kid = KID): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...exported, kid, alg: "ES256", use: "sig", key_ops: ["verify"] } };
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function claims(overrides: Record<string, unknown> = {}) {
  const now = nowSeconds();
  return { sub: "u1", aud: "authenticated", role: "authenticated", session_id: "s1", iat: now, exp: now + 3600, ...overrides };
}

// A JWT signed with ES256 over exactly the given header and payload.
export async function signed(keys: Keys, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const input = `${json(header)}.${json(payload)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

export const validToken = (keys: Keys, payload = claims()) => signed(keys, { alg: "ES256", kid: keys.jwk.kid, typ: "JWT" }, payload);

// The forged access tokens of the T26e table: none of them may open a session.
export async function forgedTokens(keys: Keys): Promise<Array<[string, string]>> {
  const header = { alg: "ES256", kid: keys.jwk.kid, typ: "JWT" };
  const other = await signed(keys, header, claims({ sub: "someone-else" }));
  const real = await validToken(keys, claims({ sub: "admin" }));
  const [h, p] = real.split(".");
  const fakeSignature = b64url(new Uint8Array(64).fill(7));
  return [
    ["a 2-part token", `${h}.${p}`],
    ["a header that is not JSON", `${b64url("not json")}.${p}.${fakeSignature}`],
    ["alg none with the real kid", `${json({ alg: "none", kid: keys.jwk.kid, typ: "JWT" })}.${p}.${fakeSignature}`],
    ["RS256 with the ES256 kid", `${json({ alg: "RS256", kid: keys.jwk.kid, typ: "JWT" })}.${p}.${fakeSignature}`],
    ["another token's signature", `${h}.${p}.${other.split(".")[2]}`],
    ["an expired exp with a future expires_at", await validToken(keys, claims({ exp: nowSeconds() - 60 }))],
    ["an unknown kid", `${json({ alg: "ES256", kid: "unknown-kid", typ: "JWT" })}.${p}.${fakeSignature}`],
    ["HS256 without a kid", `${json({ alg: "HS256", typ: "JWT" })}.${p}.${fakeSignature}`],
  ];
}

// The auth cookie @supabase/ssr reads: "base64-" + base64url(JSON session). expires_at in the future, so
// getSession() hands the access token to getClaims() without refreshing it.
export function sessionCookie(
  accessToken: string,
  expiresAt = nowSeconds() + 3600,
  refreshToken = "refresh-1",
): { name: string; value: string } {
  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    user: { id: "u1", aud: "authenticated", role: "authenticated", email: "owner@example.com" },
  };
  return { name: COOKIE_NAME, value: `base64-${json(session)}` };
}

export interface FetchStub {
  urls: string[];
  // Requests that reached PostgREST (from/rpc).
  rest(): string[];
  spy: ReturnType<typeof jest.spyOn>;
}

type Reply = { status: number; body: unknown };

// Stands in for Auth and PostgREST. Defaults: the key set holds `keys`; /user rejects the token as bad_jwt
// (what Auth answers to a token it can't verify); /token refreshes; app_access says true.
export function stubFetch(keys: Keys, replies: { jwks?: Reply; user?: Reply; token?: () => Promise<Reply>; appAccess?: Reply } = {}): FetchStub {
  const urls: string[] = [];
  const reply = ({ status, body }: Reply) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const spy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const path = new URL(url).pathname;
    if (path === "/auth/v1/.well-known/jwks.json") return reply(replies.jwks ?? { status: 200, body: { keys: [keys.jwk] } });
    if (path === "/auth/v1/user") {
      return reply(replies.user ?? { status: 403, body: { code: 403, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" } });
    }
    if (path === "/auth/v1/token") return reply(replies.token ? await replies.token() : { status: 400, body: { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" } });
    if (path === "/rest/v1/rpc/app_access") return reply(replies.appAccess ?? { status: 200, body: true });
    return reply({ status: 500, body: { message: `unexpected request in test: ${path}` } });
  });
  return { urls, rest: () => urls.filter((u) => new URL(u).pathname.startsWith("/rest/")), spy };
}

// What Auth answers to a refresh token it can't even parse ("garbage"): 400 validation_failed. auth-js then
// removes the session, so the cookie is cleared, and getClaims() returns that AuthApiError.
export const MALFORMED_REFRESH: Reply = {
  status: 400,
  body: { code: 400, error_code: "validation_failed", msg: "Invalid Refresh Token: Refresh Token Not Found" },
};

// The expired-access-token cookie whose refresh token is malformed (the case above).
export const malformedRefreshCookie = async (keys: Keys) =>
  sessionCookie(await validToken(keys, claims({ exp: nowSeconds() - 60 })), nowSeconds() - 60, "garbage");

// A refresh-token grant answer carrying a new, validly signed access token.
export async function refreshed(keys: Keys): Promise<Reply> {
  return {
    status: 200,
    body: {
      access_token: await validToken(keys),
      refresh_token: "refresh-2",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: nowSeconds() + 3600,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "owner@example.com" },
    },
  };
}
