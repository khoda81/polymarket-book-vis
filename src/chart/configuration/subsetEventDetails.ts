import type { EventDetails } from "../../domain/markets/eventDetails";
import type { Market, MarketId } from "@polymarket/client";

export function subsetEventDetails(
  details: EventDetails,
  markets: readonly Market[],
): EventDetails {
  const marketIds = new Set<MarketId>(markets.map((market) => market.id));
  return {
    ...details,
    event: { ...details.event, markets: [...markets] },
    presentation: {
      ...details.presentation,
      marketRules: details.presentation.marketRules.filter((rule) =>
        marketIds.has(rule.marketId),
      ),
    },
  };
}
