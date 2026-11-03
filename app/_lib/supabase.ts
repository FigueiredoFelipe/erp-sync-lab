// Server-only: the Supabase client of the signed-in user (T22, PLAN "Dashboard, API and access").
// It carries the user's session from the auth cookies, so every query runs under RLS as that user.
// Only the publishable key is used here; the service-role key never reaches the dashboard.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers.js";
import { openSessionWith, type Opened } from "../../src/http/access.ts";

export function supabaseEnv(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set");
  return { url, key };
}

export async function userClient(): Promise<SupabaseClient> {
  const { url, key } = supabaseEnv();
  const store = await cookies();
  // The cast bridges supabase-js's ESM and CJS type declarations, which NodeNext resolves separately
  // for @supabase/ssr and for this file; at runtime it is the same class.
  const client = createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      // @supabase/ssr also passes headers (Cache-Control: private, no-cache, no-store, ...; Expires; Pragma) so
      // that a response setting session cookies is never cached. They are not applied here: no response exists
      // yet when the session is opened, and every /api response already carries Cache-Control: no-store
      // (problemResponse, jsonResponse; tests/http/route-headers.test.ts and the refresh test in
      // tests/http/data-routes-auth.test.ts check it).
      setAll: (toSet) => {
        // Route handlers can set cookies, so a token refreshed by getClaims() is written back here (the proxy
        // passes /api and /auth through without a session). Server components can't; the proxy refreshes the session before every page,
        // so a skipped write there is harmless.
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // called from a server component
        }
      },
    },
  });
  return client as unknown as SupabaseClient;
}

// Opens a session over any server client (the routes' here, the proxy's over the request cookies): one helper,
// so both check the token the same way (openSessionWith in src/http/access.ts).
export function openClientSession<C extends SupabaseClient>(client: C): Promise<Opened<C>> {
  return openSessionWith(
    {
      getClaims: () => client.auth.getClaims(),
      getUser: () => client.auth.getUser(),
      isAllowlisted: async () => client.rpc("app_access"),
    },
    client,
  );
}

// Opens the caller's session from the cookies: no network while the access token is valid and the key set is
// cached; an expired token is refreshed (and its cookies written) before this resolves. Whether the session
// still exists and is on the allowlist is asked afterwards, together with the route's work (guarded).
export async function openSession(): Promise<Opened<SupabaseClient>> {
  return openClientSession(await userClient());
}
