import type { Event } from "@polymarket/client";
import type { EventMarket } from "./eventDetails";

export function orderMarkets(
  markets: readonly EventMarket[],
  sortBy: Event["display"]["sortBy"],
): EventMarket[] {
  const byPrice = sortBy === "price";
  const descending = byPrice || sortBy === "descending";

  return markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      value: (byPrice ? market.yes.price : market.threshold) ?? undefined,
      resolutionMs: market.resolutionMs ?? undefined,
      live: market.tradable,
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
