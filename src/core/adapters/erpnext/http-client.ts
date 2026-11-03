// Read-only HTTP client for ERPNext (PLAN "Read-only toward sources", BR09).
// It only knows GET: there are no write methods, and `request` refuses any other verb.
// Runtime-agnostic: global fetch and setTimeout only, configuration passed in.

import { SourceUnavailableError } from "../../sync/contracts.ts";

export type QueryValue = string | number | unknown[] | Record<string, unknown>;

export type ErpNextHttpConfig = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  maxAttempts?: number; // total attempts per request, including the first (default 4)
  baseDelayMs?: number; // first backoff delay, doubled each attempt (default 500)
  maxDelayMs?: number; // cap for backoff and for Retry-After (default 20 000)
  timeoutMs?: number; // per attempt (default 20 000)
  fetch?: typeof fetch; // injectable for tests
  sleep?: (ms: number) => Promise<void>; // injectable so tests don't wait
  random?: () => number; // jitter source, injectable for deterministic tests
};

// Non-retryable ERPNext failure (4xx other than 429), with the decoded Frappe message.
// Never carries request headers, so it can be logged safely.
export class ErpNextRequestError extends Error {
  readonly status: number;

  constructor(path: string, status: number, detail: string) {
    super(`GET ${path} failed with ${status}: ${detail}`);
    this.name = "ErpNextRequestError";
    this.status = status;
  }
}

export class ReadOnlyViolationError extends Error {
  constructor(method: string) {
    super(`ERPNext client is read-only: ${method} is not allowed (BR09)`);
    this.name = "ReadOnlyViolationError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ErpNextHttpClient {
  readonly #baseUrl: string;
  readonly #authHeader: string;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(config: ErpNextHttpConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.#authHeader = `token ${config.apiKey}:${config.apiSecret}`;
    this.#maxAttempts = config.maxAttempts ?? 4;
    this.#baseDelayMs = config.baseDelayMs ?? 500;
    this.#maxDelayMs = config.maxDelayMs ?? 20_000;
    this.#timeoutMs = config.timeoutMs ?? 20_000;
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#sleep = config.sleep ?? defaultSleep;
    this.#random = config.random ?? Math.random;
  }

  // GET `path` with query parameters; arrays and objects are JSON-encoded, as Frappe expects.
  async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  // Lowest level. Kept public only so the read-only guarantee can be tested: any verb but GET is refused
  // before a request is made.
  async request<T>(method: string, path: string, query: Record<string, QueryValue> = {}): Promise<T> {
    if (method.toUpperCase() !== "GET") throw new ReadOnlyViolationError(method);
    const url = this.#baseUrl + path + buildQuery(query);

    for (let attempt = 1; ; attempt++) {
      let failure: string;
      let retryAfterMs: number | undefined;

      try {
        const res = await this.#fetch(url, {
          method: "GET",
          headers: { Authorization: this.#authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (res.ok) return (await res.json()) as T;

        const text = await res.text();
        if (res.status !== 429 && res.status < 500) {
          throw new ErpNextRequestError(path, res.status, describeFrappeError(text));
        }
        failure = `HTTP ${res.status}`;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      } catch (error) {
        if (error instanceof ErpNextRequestError) throw error;
        failure = error instanceof Error ? error.name : "network error";
      }

      if (attempt >= this.#maxAttempts) {
        throw new SourceUnavailableError(`GET ${path} failed after ${attempt} attempts (last: ${failure})`);
      }
      const backoff = this.#baseDelayMs * 2 ** (attempt - 1) * (1 + 0.25 * this.#random());
      await this.#sleep(Math.min(retryAfterMs ?? backoff, this.#maxDelayMs));
    }
  }
}

function buildQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// Frappe errors carry exc_type plus _server_messages: a JSON array of JSON-encoded {message} objects.
export function describeFrappeError(text: string): string {
  try {
    const body = JSON.parse(text) as { exc_type?: string; exception?: string; _server_messages?: string; message?: unknown };
    const messages: string[] = [];
    if (body._server_messages) {
      for (const raw of JSON.parse(body._server_messages) as string[]) {
        const parsed = JSON.parse(raw) as { message?: string };
        if (parsed.message) messages.push(stripHtml(parsed.message));
      }
    }
    if (messages.length === 0 && body.exception) messages.push(body.exception.split("\n")[0] ?? "");
    if (messages.length === 0 && typeof body.message === "string") messages.push(body.message);
    return [body.exc_type, ...messages].filter(Boolean).join(" | ") || text.slice(0, 500);
  } catch {
    return stripHtml(text).slice(0, 500);
  }
}

// Retry-After is either delta-seconds or an HTTP date.
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
