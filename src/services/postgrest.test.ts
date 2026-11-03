import { describe, expect, it } from "@jest/globals";
import { isMissingRelation } from "./postgrest.ts";

describe("isMissingRelation", () => {
  it("recognizes a missing table from Postgres or PostgREST", () => {
    expect(isMissingRelation({ code: "42P01", message: 'relation "public.source_file" does not exist' })).toBe(true);
    expect(isMissingRelation({ code: "PGRST205", message: "Could not find the table 'public.source_file' in the schema cache" })).toBe(true);
    expect(isMissingRelation({ message: "Could not find the table 'public.reconciliation_run' in the schema cache" })).toBe(true);
  });

  it("does not hide any other error", () => {
    expect(isMissingRelation(null)).toBe(false);
    expect(isMissingRelation({ message: "connection refused" })).toBe(false);
    expect(isMissingRelation({ code: "42501", message: "permission denied for table invoice" })).toBe(false);
    expect(isMissingRelation({ code: "42703", message: 'column "foo" does not exist' })).toBe(false);
  });
});
