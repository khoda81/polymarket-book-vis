import type { Event, Market, MarketId } from "@polymarket/client";

export function orderMarkets(
  event: Event,
  thresholdByMarketId: ReadonlyMap<MarketId, number>,
): Market[] {
  const byPrice = event.display.sortBy === "price";
  const descending = byPrice || event.display.sortBy === "descending";

  return event.markets
    .map((market) => ({
      market,
      value: byPrice
        ? numericValue(market.outcomes.yes.price)
        : thresholdByMarketId.get(market.id),
    }))
    .sort((a, b) => {
      // Unknown values sort last in either direction; ties retain Gamma order.
      if (a.value === undefined) return b.value === undefined ? 0 : 1;
      if (b.value === undefined) return -1;
      return descending ? b.value - a.value : a.value - b.value;
    })
    .map(({ market }) => market);
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
