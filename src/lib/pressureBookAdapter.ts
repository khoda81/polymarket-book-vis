import type { CanonicalBookChange } from "./bookIngestion";
import type { FrontierLevel } from "./monotoneFrontier";
import type { TokenBook } from "./orderBook";
import type { PressureLevelChange } from "./pressureFrontierMemory";
import { complementPrice } from "./price";

export interface PressureEdgeLevels {
  readonly primaryToCollateral: readonly FrontierLevel[];
  readonly oppositeToCollateral: readonly FrontierLevel[];
}

export interface PressureEdgeChanges {
  readonly primaryToCollateral: readonly PressureLevelChange[];
  readonly oppositeToCollateral: readonly PressureLevelChange[];
}

/**
 * Canonicalize one binary CLOB into two outcome-token -> collateral edges.
 *
 * A primary-token ask already quotes the primary -> collateral edge directly.
 * A primary-token bid at p is the complementary opposite-token edge at 1-p.
 * Once converted here, historical pressure no longer needs bid/ask semantics.
 */
export function pressureEdgeLevels(book: TokenBook): PressureEdgeLevels {
  return {
    primaryToCollateral: [...book.yesToUsd.asSellOrders()].map((order) => ({
      key: order.price,
      weight: order.take,
    })),
    oppositeToCollateral: [...book.usdToYes.asOrders()].map((order) => ({
      key: complementPrice(order.price),
      weight: order.take,
    })),
  };
}

export function pressureEdgeChanges(
  changes: readonly CanonicalBookChange[],
): PressureEdgeChanges {
  const primaryToCollateral: PressureLevelChange[] = [];
  const oppositeToCollateral: PressureLevelChange[] = [];

  for (const change of changes) {
    if (change.side === "ask") {
      primaryToCollateral.push({
        price: change.price,
        shares: change.shares,
      });
    } else {
      oppositeToCollateral.push({
        price: complementPrice(change.price),
        shares: change.shares,
      });
    }
  }

  return { primaryToCollateral, oppositeToCollateral };
}
