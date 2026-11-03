// Money as integer cents, so sums and display never go through floating-point rounding.

// Converts a decimal amount as Postgres/PostgREST returns it (number or string, at most 2 decimals) to cents.
export function toCents(amount: number | string): number {
  const text = typeof amount === "number" ? amount.toFixed(2) : amount.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error(`Not a 2-decimal amount: ${text}`);
  const [, minus, whole = "0", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return minus && cents !== 0 ? -cents : cents;
}

// "1234567" -> "12345.67"; "-5" -> "-0.05".
export function centsToDecimal(cents: number): string {
  const abs = Math.abs(cents);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}

// "1234567" -> "$12,345.67" (USD, 2 decimals, en-US grouping).
export function formatUsdCents(cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `$${whole}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${text}` : text;
}
