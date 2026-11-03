// Pure helpers behind the loading vocabulary (PLAN "Loading feedback (R18)"). No DOM, no React, so
// they are unit-tested in tests/ui/ and type-check under the server tsconfig.

export type Ready = "false" | "true" | "error";

// Structural on purpose: any Load<T> from fetch-json.ts fits, without pulling browser code into the tests.
export type LoadStatus = "loading" | "ok" | "error";

export function regionReady(load: { state: LoadStatus }): Ready {
  if (load.state === "error") return "error";
  return load.state === "loading" ? "false" : "true";
}

// A page is in error if any region failed, loading if any region loads, ready otherwise.
// null stands for a region that is not on screen.
export function pageReady(...regions: (Ready | null)[]): Ready {
  if (regions.includes("error")) return "error";
  if (regions.includes("false")) return "false";
  return "true";
}

// Applying the request already shown (or in flight) does nothing; after a failure it is a retry.
export function isSameRequest<T>(next: T, applied: T, state: LoadStatus): boolean {
  return next === applied && state !== "error";
}
