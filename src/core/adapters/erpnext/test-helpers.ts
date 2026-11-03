// Test-only doubles for the ERPNext client: a scripted fetch and fixture loading. Imported by Jest tests
// only, never by runtime code, so node:fs is allowed here.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RecordedCall = { url: string; init: RequestInit | undefined };

export type ScriptedReply = Response | Error;

// Returns the scripted replies in order and records every call.
export function scriptedFetch(replies: ScriptedReply[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...replies];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error("scriptedFetch: no reply left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fake as typeof fetch, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8")) as T;
}
