import { setTimeout as sleep } from "node:timers/promises";

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500;

export type Filter = [field: string, operator: string, value: unknown];

type RequestOptions<T> = {
  body?: unknown;
  // Called before retrying a non-idempotent request after a transient failure:
  // the ERP may have committed the write even though the response was lost.
  recover?: () => Promise<T | undefined>;
};

// Non-retryable ERPNext failure (4xx), with the server's message and no request secrets.
export class ErpNextError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, detail: string) {
    super(`${method} ${path} failed with ${status}: ${detail}`);
    this.name = "ErpNextError";
    this.status = status;
  }
}

export class ErpNextClient {
  readonly #baseUrl: string;
  readonly #authHeader: string;

  constructor(baseUrl: string, apiKey: string, apiSecret: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#authHeader = `token ${apiKey}:${apiSecret}`;
  }

  async getDoc<T>(doctype: string, name: string): Promise<T | undefined> {
    try {
      const res = await this.request<{ data: T }>("GET", `/api/resource/${enc(doctype)}/${enc(name)}`);
      return res.data;
    } catch (error) {
      if (error instanceof ErpNextError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listAll<T>(doctype: string, fields: string[], filters: Filter[] = []): Promise<T[]> {
    const rows: T[] = [];
    for (let start = 0; ; start += PAGE_SIZE) {
      const query = new URLSearchParams({
        fields: JSON.stringify(fields),
        filters: JSON.stringify(filters),
        order_by: "name asc",
        limit_start: String(start),
        limit_page_length: String(PAGE_SIZE),
      });
      const res = await this.request<{ data: T[] }>("GET", `/api/resource/${enc(doctype)}?${query}`);
      rows.push(...res.data);
      if (res.data.length < PAGE_SIZE) return rows;
    }
  }

  async createDoc<T>(doctype: string, doc: object, recover?: () => Promise<T | undefined>): Promise<T> {
    const res = await this.request<{ data: T }>("POST", `/api/resource/${enc(doctype)}`, {
      body: doc,
      recover: recover && (async () => {
        const found = await recover();
        return found === undefined ? undefined : { data: found };
      }),
    });
    return res.data;
  }

  async request<T>(method: string, path: string, options: RequestOptions<T> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let failure: string;
      let retryAfterMs: number | undefined;

      try {
        const res = await fetch(this.#baseUrl + path, {
          method,
          headers: {
            Authorization: this.#authHeader,
            Accept: "application/json",
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.ok) return (await res.json()) as T;

        const text = await res.text();
        if (res.status !== 429 && res.status < 500) {
          throw new ErpNextError(method, pathOnly(path), res.status, describeFrappeError(text));
        }
        failure = `HTTP ${res.status}`;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      } catch (error) {
        if (error instanceof ErpNextError) throw error;
        failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }

      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`${method} ${pathOnly(path)} failed after ${attempt} attempts (last: ${failure})`);
      }

      const delayMs = retryAfterMs ?? BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
      console.warn(`  ! ${method} ${pathOnly(path)}: ${failure}, retrying in ${Math.round(delayMs)} ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await sleep(delayMs);

      if (options.recover) {
        const recovered = await options.recover();
        if (recovered !== undefined) return recovered;
      }
    }
  }
}

// Frappe errors carry exc_type plus _server_messages: a JSON array of JSON-encoded {message} objects.
function describeFrappeError(text: string): string {
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

function parseRetryAfter(value: string | null): number | undefined {
  const seconds = Number(value);
  return value && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Query strings can be long; error messages only need the resource path.
function pathOnly(path: string): string {
  return decodeURIComponent(path.split("?")[0] ?? path);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
