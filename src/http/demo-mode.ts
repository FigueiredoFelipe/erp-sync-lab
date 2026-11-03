// Public demo mode (DEMO_ONLY=true on the public deployment): every page goes to /demo, which renders a frozen
// snapshot, and the data and auth routes are refused, so no request opens a Supabase client. Off by default, so a
// clone runs the full signed-in dashboard.
export const DEMO_PATH = "/demo";

export type DemoRoute = "pass" | "to-demo" | "not-found";

export function demoRoute(path: string, demoOnly: boolean): DemoRoute {
  if (path === DEMO_PATH || !demoOnly) return "pass";
  if (path.startsWith("/api/") || path.startsWith("/auth/")) return "not-found";
  return "to-demo";
}

export function demoOnly(): boolean {
  return process.env["DEMO_ONLY"] === "true";
}
