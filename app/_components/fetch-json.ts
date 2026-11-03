// Client-side fetch of the dashboard's own API routes. Data is fetched in the browser on purpose,
// so every call shows in DevTools (PLAN "Agent-driven UI verification").

export class ApiError extends Error {
  readonly status: number;
  constructor(url: string, status: number, detail: string | undefined) {
    super(`${url} returned ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  // A page shell from the router cache must never outlive a refused call: leave for /login or /denied and
  // never settle, so the page shows neither data nor an error in the meantime (PLAN R17).
  const leaveFor = response.status === 401 ? "/login" : response.status === 403 ? "/denied" : null;
  if (leaveFor) {
    window.location.assign(leaveFor);
    return new Promise<never>(() => {});
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new ApiError(url, response.status, problem?.detail);
  }
  return (await response.json()) as T;
}

export type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10" -> "Oct 2026".
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// "2026-10-18" -> "Oct 18, 2026".
export function dateLabel(date: string): string {
  return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}
