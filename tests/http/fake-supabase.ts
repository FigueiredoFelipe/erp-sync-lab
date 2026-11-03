// A minimal stand-in for the supabase-js client: records the query chain and resolves canned results.
//
// A table or function result may be a list: one result per query, in creation order (when `from`/`rpc` is called,
// not when the query is awaited), the last one repeating.
// `from` and `rpc` both return lazy builders: nothing is "sent" until the query is awaited (`then`),
// as in supabase-js. With `{ deferred: true }`, every awaited query stays pending until the test
// releases it, so a test can see which queries were issued together before any of them answered.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export type Results = Result | Result[];

export interface Call {
  table?: string;
  rpc?: string;
  args?: unknown;
  chain: [string, ...unknown[]][];
}

export interface FakeOptions {
  // Hold every issued query until release()/releaseAll().
  deferred?: boolean;
}

export interface FakeClient {
  client: SupabaseClient;
  // Every query built, in build order (issued or not).
  calls: Call[];
  // The queries awaited so far, in the order they were awaited (recorded on `then`, not on `from`/`rpc`).
  issued(): Call[];
  // Lets every pending microtask run, so queries started together are all issued.
  settle(): Promise<void>;
  // Deferred mode: answers the issued, still pending queries on this table/function (or matching the
  // predicate); returns how many were released.
  release(target: string | ((call: Call) => boolean)): number;
  // Deferred mode: answers every issued, still pending query.
  releaseAll(): number;
}

interface Pending {
  call: Call;
  open: () => void;
}

export function fakeSupabase(tables: Record<string, Results>, rpcs: Record<string, Results> = {}, options: FakeOptions = {}): FakeClient {
  const calls: Call[] = [];
  const issuedCalls: Call[] = [];
  let pending: Pending[] = [];
  const seen = new Map<string, number>();

  // The n-th call to a table or function gets the n-th result; the last one repeats.
  const pick = (key: string, results: Results | undefined, fallback: Result): Result => {
    if (results === undefined) return fallback;
    if (!Array.isArray(results)) return results;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return results[Math.min(n, results.length - 1)] ?? fallback;
  };

  const query = (call: Call, result: Result) => {
    let answer: Promise<Result> | null = null;
    const issue = (): Promise<Result> => {
      if (answer) return answer;
      issuedCalls.push(call);
      if (!options.deferred) {
        answer = Promise.resolve(result);
      } else {
        answer = new Promise<Result>((resolve) => {
          pending.push({ call, open: () => resolve(result) });
        });
      }
      return answer;
    };
    const builder = (): unknown => {
      const target = {
        then: (resolve?: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => issue().then(resolve, reject),
      };
      return new Proxy(target, {
        get(obj, prop) {
          if (prop === "then") return obj.then;
          return (...args: unknown[]) => {
            call.chain.push([String(prop), ...args]);
            return builder();
          };
        },
      });
    };
    return builder();
  };

  const release = (target: string | ((call: Call) => boolean)): number => {
    const matches = typeof target === "string" ? (call: Call) => call.table === target || call.rpc === target : target;
    const now = pending.filter((p) => matches(p.call));
    pending = pending.filter((p) => !matches(p.call));
    for (const p of now) p.open();
    return now.length;
  };

  const client = {
    from(table: string) {
      const call: Call = { table, chain: [] };
      calls.push(call);
      return query(call, pick(`table:${table}`, tables[table], { data: null, error: { message: `unknown table ${table}` } }));
    },
    rpc(name: string, args?: unknown) {
      const call: Call = { rpc: name, args, chain: [] };
      calls.push(call);
      return query(call, pick(`rpc:${name}`, rpcs[name], { data: null, error: { message: `unknown function ${name}` } }));
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
    issued: () => [...issuedCalls],
    settle: () => new Promise<void>((resolve) => setImmediate(resolve)),
    release,
    releaseAll: () => release(() => true),
  };
}

// The issued queries as "table" or "rpc:name", sorted, for set comparisons in round-trip tests.
export function issuedNames(fake: FakeClient): string[] {
  return fake
    .issued()
    .map((call) => (call.rpc ? `rpc:${call.rpc}` : String(call.table)))
    .sort();
}
