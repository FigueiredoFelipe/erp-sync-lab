// T22: the only way in is Google (PLAN "Dashboard, API and access"). The form posts to /auth/login,
// which sends the browser to Google's consent page.
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  start: "Google sign-in could not be started. Try again.",
  callback: "Google sign-in did not complete. Try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const message = error ? ERRORS[error] : undefined;
  return (
    <main className="auth-page">
      <section className="card auth-card">
        <h1>Sign in</h1>
        <p>This dashboard is private. Sign in with an allowlisted Google account.</p>
        {message && (
          <p className="error" role="alert" data-testid="login-error">
            {message}
          </p>
        )}
        <form action="/auth/login" method="post">
          <button type="submit" data-testid="login-google">
            Sign in with Google
          </button>
        </form>
      </section>
    </main>
  );
}
