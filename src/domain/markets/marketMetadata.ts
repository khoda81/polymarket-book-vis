import type { Market } from "@polymarket/client";

/** Gamma's row label for a market, if it reports one. */
export function marketTitle(
  market: Pick<Market, "groupItemTitle" | "question">,
): string | null {
  return market.groupItemTitle ?? market.question ?? null;
}

/** Case, Unicode-form and whitespace-insensitive key for display text. */
export function normalizeDisplayText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sameDisplayTitle(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return normalizeDisplayText(a) === normalizeDisplayText(b);
}
