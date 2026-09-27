import type { CanonicalBookChange } from "./bookIngestion";
import type { FrontierLevel } from "./monotoneFrontier";
import type { TokenBook } from "./orderBook";
import type { PressureLevelChange } from "./pressureFrontierMemory";

/**
 * Token-local pressure is the token -> collateral supply edge: resting asks.
 * Bids belong to the reverse edge and are deliberately not folded into this
 * token's persisted pressure history.
 */
export function tokenPressureLevels(book: TokenBook): readonly FrontierLevel[] {
  return [...book.yesToUsd.asSellOrders()].map((order) => ({
    key: order.price,
    weight: order.take,
  }));
}

export function tokenPressureChanges(
  changes: readonly CanonicalBookChange[],
): readonly PressureLevelChange[] {
  return changes.flatMap((change) =>
    change.side === "ask"
      ? [{ price: change.price, shares: change.shares }]
      : [],
  );
}
