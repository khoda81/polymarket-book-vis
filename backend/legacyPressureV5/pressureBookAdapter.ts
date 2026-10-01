import type { CanonicalBookChange } from "../../src/domain/books/bookIngestion";
import type { TokenBook } from "../../src/domain/books/orderBook";
import type { FrontierLevel } from "./monotoneFrontier";
import type { PressureLevelChange } from "./pressureFrontierMemory";

/**
 * Legacy v5 recorder adapter. Keep this isolated from the frontend pressure
 * representation until the TypeScript recorder is removed.
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
