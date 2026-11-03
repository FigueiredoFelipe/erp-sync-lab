// Customer name normalization (BR05, PLAN "Customer resolution"). It only builds a lookup key: the mapping
// decides every match. Legal suffixes (Inc, LLC, Co) are kept on purpose, so "Acme Co" and "Acme Inc"
// never collapse into one customer.

// Lowercase, punctuation and symbols removed, whitespace collapsed and trimmed.
// "Cedar Valley Bakery, Inc." -> "cedar valley bakery inc"; "REDWOOD  PIZZA KITCHEN" -> "redwood pizza kitchen".
export function normalizeCustomerName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
