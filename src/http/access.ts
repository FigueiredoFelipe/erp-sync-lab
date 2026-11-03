// T22/T26: every data route answers only an allowlisted Google session (PLAN "Dashboard, API and access",
// "Dashboard responsiveness (R17)", AC10, AC24). The database enforces the same rule with RLS; this gate turns
// it into the right status code (401 no session, 403 not on the allowlist) instead of an empty 200.
// The session is opened first (the access token's signature checked; no network while it is valid); then Auth, the allowlist and the route's
// work run together, and the access decision always wins over whatever the work produced.
import { problemResponse } from "./problem.ts";

export type AuthError = { name?: string; status?: number; code?: string; message: string };

export type Decision = "signed-out" | "denied" | "allowed" | "error";
export type PageDecision = Exclude<Decision, "error">;

type UserResult = { data: { user: unknown }; error: AuthError | null };
type AllowResult = { data: unknown; error: { message: string } | null };

// The two questions asked of Supabase once a session is open: is it still signed in, and is that account
// on the allowlist.
export interface Session<C> {
  getUser(): Promise<UserResult>;
  isAllowlisted(): Promise<AllowResult>;
  client: C;
}

export type Opened<C> = { status: "signed-out" } | { status: "open"; session: Session<C> };

type Handler = (request: Request) => Promise<Response>;

// One rule for both Auth calls, getClaims() when opening a session and getUser() once it is open (PLAN R17
// point 1). Signed out: no session (AuthSessionMissingError), a token that fails local verification
// (AuthInvalidJwtError), or an AuthApiError that Auth answered with an error code on a 4xx that is not a rate
// limit or an outage (a malformed refresh token gives 400 validation_failed, a signed-out session 403
// session_not_found). Everything else is an outage, so the caller answers 500 and never a misleading 401: an
// AuthApiError without a code (the API gateway's 401 "Invalid API key", a key-set fetch 404), 5xx, 429, status
// 0 (unreachable), AuthRefreshDiscardedError (409, a concurrent refresh won) and any other error.
function isRateLimitOrOutageCode(code: string): boolean {
  return /^over_[a-z_]*rate_limit$/.test(code) || OUTAGE_CODES.has(code);
}
const OUTAGE_CODES = new Set(["unexpected_failure", "request_timeout", "hook_timeout", "hook_timeout_after_retry"]);

export function isSignedOutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, status, code } = error as { name?: unknown; status?: unknown; code?: unknown };
  if (name === "AuthSessionMissingError" || name === "AuthInvalidJwtError") return true;
  if (name !== "AuthApiError") return false;
  if (typeof code !== "string" || code === "") return false;
  if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) return false;
  return !isRateLimitOrOutageCode(code);
}

// What auth.getClaims() resolves to: claims of a token whose signature was checked (locally against the
// project's key set, or by Auth for an HS-signed or kid-less token), no session at all, or an Auth error.
export type ClaimsResult = { data: { claims: unknown } | null; error: AuthError | null };

// auth-js marks its own errors; anything else thrown by getClaims() comes from decoding or verifying the token.
function isAuthError(error: unknown): error is AuthError {
  return typeof error === "object" && error !== null && (error as { __isAuthError?: unknown }).__isAuthError === true;
}

// The result of auth.getClaims(). Throws on an outage (isSignedOutError false), so the caller answers 500 and
// not a misleading 401.
export function classifyClaims(result: ClaimsResult): "absent" | "present" {
  if (result.error) {
    if (isSignedOutError(result.error)) return "absent";
    throw new Error(`getClaims failed: ${result.error.message}`, { cause: result.error });
  }
  return result.data?.claims ? "present" : "absent";
}

// What opening a session needs from a Supabase client.
export interface SessionOps {
  getClaims(): Promise<ClaimsResult>;
  getUser(): Promise<UserResult>;
  isAllowlisted(): Promise<AllowResult>;
}

// The one way a session is opened, for the proxy and the data routes alike: the access token's signature is
// checked first (no network while it is valid and its key is cached), so a forged or malformed cookie is no
// session and starts no database query. getClaims() returns Auth errors and rethrows anything else, which can
// only come from decoding or verifying the token locally (JSON.parse, an unsupported alg, a key of another
// type): an unverifiable token, so signed out. Outages throw (classifyClaims).
export async function openSessionWith<C>(ops: SessionOps, client: C): Promise<Opened<C>> {
  let result: ClaimsResult;
  try {
    result = await ops.getClaims();
  } catch (error) {
    if (!isAuthError(error)) return { status: "signed-out" };
    result = { data: null, error };
  }
  if (classifyClaims(result) === "absent") return { status: "signed-out" };
  return {
    status: "open",
    session: { getUser: () => ops.getUser(), isAllowlisted: () => ops.isAllowlisted(), client },
  };
}

// Fixed precedence (PLAN R17): an Auth outage, then no user, then an allowlist failure, then anything but true.
export function decideAccess(
  user: PromiseSettledResult<UserResult>,
  allow: PromiseSettledResult<AllowResult>,
): Decision {
  if (user.status === "rejected") return "error";
  const { data, error } = user.value;
  if (error && !isSignedOutError(error)) return "error";
  if (error || !data?.user) return "signed-out";
  if (allow.status === "rejected" || allow.value.error) return "error";
  return allow.value.data === true ? "allowed" : "denied";
}

// Where a page request goes (proxy.ts): pages need an allowlisted session; /login is for signed-out
// visitors and /denied for sessions off the allowlist. null means "serve the page".
export function pageRedirect(path: string, decision: PageDecision): string | null {
  if (decision === "signed-out") return path === "/login" ? null : "/login";
  if (decision === "denied") return path === "/denied" ? null : "/denied";
  return path === "/login" || path === "/denied" ? "/" : null;
}

// Which check a page request gets (PLAN R17 point 2). A document load, a request without Sec-Fetch-Dest, and
// /login and /denied always (their content depends on the decision) get the full one; an in-app navigation or
// prefetch (Sec-Fetch-Dest present and not "document") only opens the session locally, because pages render no
// data on the server and the data routes stay the authoritative gate. Next strips the rsc headers before the
// proxy runs, so they can't be used here.
export function pageCheck(path: string, secFetchDest: string | null): "full" | "local" {
  if (path === "/login" || path === "/denied") return "full";
  return secFetchDest === null || secFetchDest === "document" ? "full" : "local";
}

// The page check: without a session the allowlist is never asked. Throws on an outage, so the page fails.
export async function pageAccess<C>(open: () => Promise<Opened<C>>): Promise<PageDecision> {
  const opened = await open();
  if (opened.status === "signed-out") return "signed-out";
  const { session } = opened;
  const [user, allow] = await Promise.allSettled([
    Promise.resolve().then(() => session.getUser()),
    Promise.resolve().then(() => session.isAllowlisted()),
  ]);
  const decision = decideAccess(user, allow);
  if (decision === "error") throw new Error("Checking page access failed", { cause: accessFailure(user, allow) });
  return decision;
}

// Opens the session, then runs Auth, the allowlist and the route's handler together over the caller's own
// database client. Only an allowed caller sees the handler's response, with Server-Timing added.
export function guarded<C>(
  open: () => Promise<Opened<C>>,
  handlerFor: (client: C) => Handler,
  clock: () => number = () => performance.now(),
): Handler {
  return async function GET(request: Request): Promise<Response> {
    const started = clock();
    let opened: Opened<C>;
    try {
      opened = await open();
    } catch (error) {
      console.error("Opening the session failed", error);
      return problemResponse(500, "Unexpected error while checking the session.");
    }
    if (opened.status === "signed-out") return signedOut();

    const { session } = opened;
    const [user, allow, handled] = await Promise.allSettled([
      Promise.resolve().then(() => session.getUser()),
      Promise.resolve().then(() => session.isAllowlisted()),
      Promise.resolve().then(() => handlerFor(session.client)(request)),
    ]);
    const decision = decideAccess(user, allow);
    if (decision === "error") {
      console.error("Checking access failed", accessFailure(user, allow));
      return problemResponse(500, "Unexpected error while checking the session.");
    }
    if (decision === "signed-out") return signedOut();
    if (decision === "denied") return problemResponse(403, "This account is not on the allowlist.");

    if (handled.status === "rejected") {
      console.error(`GET ${new URL(request.url).pathname} failed`, handled.reason);
      return withTiming(problemResponse(500, "Unexpected error while reading the data."), clock() - started);
    }
    return withTiming(handled.value, clock() - started);
  };
}

const signedOut = () => problemResponse(401, "Sign in with Google to read this data.");

// A new response with the same body, status and headers plus Server-Timing; the handler's is never mutated.
function withTiming(response: Response, ms: number): Response {
  const headers = new Headers(response.headers);
  headers.set("server-timing", `app;dur=${ms.toFixed(1)}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function accessFailure(user: PromiseSettledResult<UserResult>, allow: PromiseSettledResult<AllowResult>) {
  return {
    getUser: user.status === "rejected" ? user.reason : user.value.error,
    appAccess: allow.status === "rejected" ? allow.reason : allow.value.error,
  };
}
