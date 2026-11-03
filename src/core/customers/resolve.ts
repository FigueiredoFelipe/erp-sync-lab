// Customer resolution (BR05, PLAN "Customer resolution"). The index is built from the mapping's aliases
// (internal.customer_alias, stored exactly as the mapping file writes them) and the mapping_version they
// belong to. Source A resolves by the exact ERPNext customer ID; Source B by the normalized name, which
// must equal a normalized alias. Similarity never decides.

import type { SourceId } from "../canonical.ts";
import { normalizeCustomerName } from "./normalize.ts";

export type CustomerAlias = { source: SourceId; matchKey: string; canonicalId: string };

export type CustomerIndex = {
  mappingVersion: number;
  erpnext: ReadonlyMap<string, string>; // ERPNext customer ID -> canonical_id
  legacyUnitB: ReadonlyMap<string, string>; // normalized Unit B name -> canonical_id
};

export class CustomerMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerMappingError";
  }
}

// Fails closed on an ambiguous mapping: two Unit B aliases that normalize to the same key but point at
// different customers would make resolution depend on row order.
export function buildCustomerIndex(mappingVersion: number, aliases: readonly CustomerAlias[]): CustomerIndex {
  if (!Number.isInteger(mappingVersion) || mappingVersion < 0) {
    throw new CustomerMappingError(`invalid mapping_version ${String(mappingVersion)}`);
  }
  const erpnext = new Map<string, string>();
  const legacyUnitB = new Map<string, string>();
  for (const alias of aliases) {
    if (alias.canonicalId === "") throw new CustomerMappingError(`alias ${JSON.stringify(alias.matchKey)} has no canonical_id`);
    const [map, key] =
      alias.source === "erpnext" ? [erpnext, alias.matchKey] : [legacyUnitB, normalizeCustomerName(alias.matchKey)];
    if (key === "") throw new CustomerMappingError(`empty ${alias.source} alias for ${alias.canonicalId}`);
    const existing = map.get(key);
    if (existing !== undefined && existing !== alias.canonicalId) {
      throw new CustomerMappingError(
        `${alias.source} alias ${JSON.stringify(alias.matchKey)} is ambiguous: ${existing} and ${alias.canonicalId}`,
      );
    }
    map.set(key, alias.canonicalId);
  }
  return { mappingVersion, erpnext, legacyUnitB };
}

// The canonical_id for a source customer, or null when the mapping doesn't list it (UNKNOWN_CUSTOMER).
export function resolveCustomer(index: CustomerIndex, source: SourceId, sourceCustomer: string | null): string | null {
  if (sourceCustomer === null) return null;
  if (source === "erpnext") return index.erpnext.get(sourceCustomer) ?? null;
  const key = normalizeCustomerName(sourceCustomer);
  return key === "" ? null : (index.legacyUnitB.get(key) ?? null);
}
