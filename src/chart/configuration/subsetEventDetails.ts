import type { EventDetails } from "../../domain/markets/eventDetails";
import { initialMarketLifecycle } from "../../domain/markets/marketLifecycle";
import { isActiveOrderMarket } from "../../domain/markets/marketTradability";
import type { Market, MarketId } from "@polymarket/client";

/**
 * Preserve the original standalone event-card rule: show trading markets and
 * keep resolved markets available to the hidden-market controls. Series views
 * deliberately retain their full historical market lists.
 */
export function eventCardDetails(details: EventDetails): EventDetails {
  return subsetEventDetails(
    details,
    details.event.markets.filter((market) => {
      const lifecycle = initialMarketLifecycle(market);
      return isActiveOrderMarket(market) || lifecycle.kind === "resolved";
    }),
  );
}

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
