import type { Event, Market, MarketId } from "@polymarket/client";
import { isActiveOrderMarket } from "./marketTradability";

export function orderMarkets(
  event: Event,
  thresholdByMarketId: ReadonlyMap<MarketId, number>,
  resolutionMsByMarketId: ReadonlyMap<MarketId, number> = new Map(),
): Market[] {
  const byPrice = event.display.sortBy === "price";
  const descending = byPrice || event.display.sortBy === "descending";

  return event.markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      value: byPrice
        ? numericValue(market.outcomes.yes.price)
        : thresholdByMarketId.get(market.id),
      resolutionMs: resolutionMsByMarketId.get(market.id),
      live: isActiveOrderMarket(market),
    }))
    .sort((a, b) => {
      if (!byPrice && a.live !== b.live) {
        // Closed rows describe the historical prefix of an ascending deadline
        // ladder. Live rows describe its still-trading suffix. Gamma's
        // threshold keys remain authoritative inside the live suffix, where
        // placeholder endDate values are common.
        return descending ? (a.live ? -1 : 1) : a.live ? 1 : -1;
      }

      if (!byPrice && !a.live) {
        const deadline = compareOptionalNumbers(
          a.resolutionMs,
          b.resolutionMs,
          descending,
        );
        if (deadline !== null && deadline !== 0) return deadline;
      }

      const display = compareOptionalNumbers(a.value, b.value, descending);
      if (display !== null) return display || a.originalIndex - b.originalIndex;

      const deadline = compareOptionalNumbers(
        a.resolutionMs,
        b.resolutionMs,
        descending,
      );
      return deadline ?? a.originalIndex - b.originalIndex;
    })
    .map(({ market }) => market);
}

function compareOptionalNumbers(
  a: number | undefined,
  b: number | undefined,
  descending: boolean,
): number | null {
  if (a === undefined) return b === undefined ? null : 1;
  if (b === undefined) return -1;
  return descending ? b - a : a - b;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
