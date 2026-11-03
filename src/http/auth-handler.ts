// T22: Google sign-in through Supabase Auth (PLAN "Dashboard, API and access"). Thin handlers over the
// part of supabase-js auth they use, so they can be tested with a fake.
//   POST /auth/login     -> 303 to Google's consent page (PKCE verifier kept in a cookie by the client)
//   GET  /auth/callback  -> exchanges the code for a session, then 303 to the dashboard
//   POST /auth/logout    -> ends the session, then 303 to /login

export interface AuthApi {
  signInWithOAuth(credentials: {
    provider: "google";
    options: { redirectTo: string };
  }): Promise<{ data: { url: string | null }; error: { message: string } | null }>;
  exchangeCodeForSession(code: string): Promise<{ error: { message: string } | null }>;
  signOut(): Promise<{ error: { message: string } | null }>;
}

type GetAuth = () => Promise<AuthApi>;

// no-store: these redirects carry session cookies and must never be replayed from a cache.
const seeOther = (url: URL | string) =>
  new Response(null, { status: 303, headers: { location: String(url), "cache-control": "no-store" } });

export function createLoginHandler(getAuth: GetAuth) {
  return async function POST(request: Request): Promise<Response> {
    const origin = new URL(request.url).origin;
    const auth = await getAuth();
    const { data, error } = await auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${origin}/auth/callback` },
    });
    if (error || !data.url) {
      console.error("Starting Google sign-in failed", error);
      return seeOther(new URL("/login?error=start", origin));
    }
    return seeOther(data.url);
  };
}

export function createCallbackHandler(getAuth: GetAuth) {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    if (!code) return seeOther(new URL("/login?error=callback", url.origin));
    const { error } = await (await getAuth()).exchangeCodeForSession(code);
    if (error) {
      console.error("Exchanging the sign-in code failed", error);
      return seeOther(new URL("/login?error=callback", url.origin));
    }
    // The proxy sends a session that isn't allowlisted on to /denied.
    return seeOther(new URL("/", url.origin));
  };
}

export function createLogoutHandler(getAuth: GetAuth) {
  return async function POST(request: Request): Promise<Response> {
    const { error } = await (await getAuth()).signOut();
    if (error) console.error("Sign-out failed", error);
    return seeOther(new URL("/login", new URL(request.url).origin));
  };
}
