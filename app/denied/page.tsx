// T22 / AC10: a Google account that is signed in but not on the allowlist lands here and sees no data.
// The proxy sends it here; even if it reached a data page, RLS would return no rows and the API 403.
import { userClient } from "../_lib/supabase.ts";

export const dynamic = "force-dynamic";

export default async function DeniedPage() {
  const { data } = await (await userClient()).auth.getUser();
  return (
    <main className="auth-page">
      <section className="card auth-card" data-testid="access-denied">
        <h1>Access denied</h1>
        <p>
          <strong data-testid="denied-email">{data.user?.email ?? "This account"}</strong> is not on the allowlist for
          this dashboard.
        </p>
        <form action="/auth/logout" method="post">
          <button type="submit" data-testid="logout">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
