"use client";

// Top navigation, on every page (app/layout.tsx). Stable data-testids for agent-driven verification.
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Revenue", testId: "nav-revenue" },
  { href: "/customers", label: "Customers", testId: "nav-customers" },
  { href: "/quarantine", label: "Quarantine", testId: "nav-quarantine" },
  { href: "/health", label: "Sync health", testId: "nav-health" },
] as const;

// Marks the clicked link as pending at once (PLAN "Loading feedback (R18)", AC26): dashed underline and an
// inline spinner, styled through `.nav a:has([data-pending="true"])`. Must be a child of the <Link>.
export function NavPending() {
  const { pending } = useLinkStatus();
  return (
    <span className="nav-pending" data-pending={pending ? "true" : "false"} aria-hidden="true">
      {pending && <span className="spinner" />}
    </span>
  );
}

// The sign-in, access-denied and public demo pages show only the brand: the demo has no other page to go to.
const BARE_PAGES = ["/login", "/denied", "/demo"];

export function Nav() {
  const pathname = usePathname();
  const bare = BARE_PAGES.includes(pathname ?? "");
  return (
    <header className="topbar">
      <nav aria-label="Main" className="nav">
        <span className="brand">Harvest Table Foods</span>
        {!bare && (
        <ul>
          {LINKS.map((link) => {
            const active = link.href === "/" ? pathname === "/" : pathname?.startsWith(link.href);
            return (
              <li key={link.href}>
                <Link href={link.href} data-testid={link.testId} aria-current={active ? "page" : undefined}>
                  {link.label}
                  <NavPending />
                </Link>
              </li>
            );
          })}
        </ul>
        )}
        {!bare && (
          <form action="/auth/logout" method="post" className="nav-signout">
            <button type="submit" className="link" data-testid="logout">
              Sign out
            </button>
          </form>
        )}
      </nav>
    </header>
  );
}
