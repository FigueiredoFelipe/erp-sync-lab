// Helpers for reading PostgREST errors from supabase-js.

export interface PostgrestErrorLike {
  message: string;
  code?: string;
}

// True when the table or view does not exist (yet): Postgres 42P01 passed through, or PostgREST's
// PGRST205 "Could not find the table ... in the schema cache". Tables owned by later tasks
// (source_file, reconciliation_run) may be missing; their parts of the dashboard degrade to "not available yet".
export function isMissingRelation(error: PostgrestErrorLike | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /does not exist|schema cache/i.test(error.message) && /relation|table/i.test(error.message);
}
