// T22/T26: runs before every page request (Next.js 16 "proxy", formerly middleware).
// 1. Opens the Supabase session with the same helper as the data routes (openClientSession): the token's
//    signature is checked, and an expired token is refreshed with its cookies written to the response.
// 2. A document load (or a request without Sec-Fetch-Dest), and /login and /denied always, get the full check:
//    no session -> /login (without asking the allowlist); a session off the allowlist -> /denied (AC10); an
//    allowlisted session never sees /login or /denied.
// 3. An in-app navigation or prefetch (Sec-Fetch-Dest present and not "document") only gets the local check:
//    no valid session -> /login, otherwise the page shell, without asking Auth or the allowlist (PLAN R17
//    point 2). Pages render no data on the server; the data routes stay the authoritative gate.
// /api and /auth pass through untouched: they open the session themselves and answer 401/403 (src/http/access.ts).
// /demo needs no session. With DEMO_ONLY=true (the public deployment) every other page goes to /demo and /api, /auth
// answer 404, before any Supabase client exists (src/http/demo-mode.ts).
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server.js";
import { openClientSession, supabaseEnv } from "./app/_lib/supabase.ts";
import { pageAccess, pageCheck, pageRedirect, type PageDecision } from "./src/http/access.ts";
import { DEMO_PATH, demoOnly, demoRoute } from "./src/http/demo-mode.ts";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const demo = demoRoute(path, demoOnly());
  if (demo === "to-demo") return NextResponse.redirect(new URL(DEMO_PATH, request.url));
  if (demo === "not-found") return new NextResponse(null, { status: 404 });
  if (path === DEMO_PATH || path.startsWith("/api/") || path.startsWith("/auth/")) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const { url, key } = supabaseEnv();

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet, headers) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // Cache-Control: no-store, so no shared cache ever keeps a response that carries session cookies.
        for (const [name, value] of Object.entries(headers ?? {})) response.headers.set(name, value);
      },
    },
  }) as unknown as SupabaseClient;

  // An Auth or database outage throws, so the page fails instead of sending anyone to /login.
  const opened = await openClientSession(supabase);
  let decision: PageDecision | null;
  if (pageCheck(path, request.headers.get("sec-fetch-dest")) === "full") {
    decision = await pageAccess(async () => opened);
  } else {
    decision = opened.status === "signed-out" ? "signed-out" : null;
  }

  const to = decision ? pageRedirect(path, decision) : null;
  if (!to) return response;
  const target = NextResponse.redirect(new URL(to, request.url));
  for (const cookie of response.cookies.getAll()) target.cookies.set(cookie);
  for (const name of ["cache-control", "expires", "pragma"]) {
    const value = response.headers.get(name);
    if (value) target.headers.set(name, value);
  }
  return target;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
