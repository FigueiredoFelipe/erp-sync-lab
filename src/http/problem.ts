// Problem Details (RFC 9457) responses, the only error shape the API returns.

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  405: "Method Not Allowed",
  500: "Internal Server Error",
};

export function problemResponse(status: number, detail: string, headers: Record<string, string> = {}): Response {
  const body: Problem = { type: "about:blank", title: TITLES[status] ?? "Error", status, detail };
  const merged = new Headers(headers);
  merged.set("content-type", "application/problem+json");
  // set() after the caller's headers, whatever their casing, so no caller can make an error response
  // cacheable (PLAN R17). A plain object spread would keep "Cache-Control: public" next to "cache-control".
  merged.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: merged });
}

// Every other method on a route that answers only `allowed`.
export function onlyAllow(allowed: "GET" | "POST") {
  return function methodNotAllowed(request: Request): Response {
    return problemResponse(405, `Method ${request.method} is not allowed; use ${allowed}.`, { allow: allowed });
  };
}

// Every method other than GET on a GET-only route.
export const methodNotAllowed = onlyAllow("GET");

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
