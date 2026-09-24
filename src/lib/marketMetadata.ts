import type { Event, MarketId, TokenId } from "@polymarket/client";

export function resolutionOrder(
  event: Event,
  resolutionMsByMarketId: ReadonlyMap<MarketId, number>,
): Map<TokenId, number> {
  const sorted = event.markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionMsByMarketId.get(market.id) ?? Infinity,
    }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.timestamp);
      const bKnown = Number.isFinite(b.timestamp);
      if (aKnown && bKnown)
        return a.timestamp - b.timestamp || a.originalIndex - b.originalIndex;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const order = new Map<TokenId, number>();
  for (const [index, { market }] of sorted.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) order.set(tokenId, index);
  }
  return order;
}

export function sameDisplayTitle(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return normalizeDisplayTitle(a) === normalizeDisplayTitle(b);
}

function normalizeDisplayTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
