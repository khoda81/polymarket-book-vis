import type {
  EventDetails,
  EventMarket,
} from "../../domain/markets/eventDetails";

/**
 * Preserve the original standalone event-card rule: show trading markets and
 * keep resolved markets available to the hidden-market controls. Series views
 * deliberately retain their full historical market lists.
 */
export function eventCardDetails(details: EventDetails): EventDetails {
  return subsetEventDetails(
    details,
    details.markets.filter(
      (market) =>
        market.tradable || market.reportedLifecycle.kind === "resolved",
    ),
  );
}

export function subsetEventDetails(
  details: EventDetails,
  markets: readonly EventMarket[],
): EventDetails {
  return { ...details, markets };
}
