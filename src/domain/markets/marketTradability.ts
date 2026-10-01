import type { Market } from "@polymarket/client";

/** Markets eligible for live order-book controls and subscriptions. */
export function isActiveOrderMarket(market: Pick<Market, "state">): boolean {
  return market.state.active === true && market.state.acceptingOrders === true;
}
