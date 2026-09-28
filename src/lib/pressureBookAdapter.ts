import type { CanonicalBookChange } from "./bookIngestion";
import { effectiveAskPrice, type FeeSchedule } from "./feeSchedule";
import type { TokenBook } from "./orderBook";
import type {
  PressureLevel,
  PressureLevelChange,
} from "./pressureFrontierMemory";
import type { Price } from "./price";

/**
 * Token-local pressure is the token -> collateral supply edge: resting asks.
 * The retained order book stays in raw venue-price space; this is the boundary
 * where pressure is projected into fee-adjusted taker BUY price space.
 */
export function tokenPressureLevels(
  book: TokenBook,
  schedule: FeeSchedule,
): readonly PressureLevel[] {
  const sharesByPrice = new Map<Price, number>();
  for (const order of book.yesToUsd.asSellOrders()) {
    const price = effectiveAskPrice(order.price, schedule);
    sharesByPrice.set(price, (sharesByPrice.get(price) ?? 0) + order.take);
  }
  return [...sharesByPrice].map(([price, shares]) => ({ price, shares }));
}

/**
 * Recompute each affected effective bucket from the current raw book.
 *
 * Multiple raw venue ticks can quantize into one effective price, so mapping a
 * delta independently would lose the sibling raw levels in that bucket.
 */
export function tokenPressureChanges(
  book: TokenBook,
  changes: readonly CanonicalBookChange[],
  schedule: FeeSchedule,
): readonly PressureLevelChange[] {
  const affected = new Set<Price>();
  for (const change of changes)
    if (change.side === "ask")
      affected.add(effectiveAskPrice(change.price, schedule));

  if (affected.size === 0) return [];

  const sharesByPrice = new Map<Price, number>();
  for (const price of affected) sharesByPrice.set(price, 0);

  for (const order of book.yesToUsd.asSellOrders()) {
    const price = effectiveAskPrice(order.price, schedule);
    if (sharesByPrice.has(price))
      sharesByPrice.set(price, sharesByPrice.get(price)! + order.take);
  }

  return [...sharesByPrice]
    .sort(([left], [right]) => left - right)
    .map(([price, shares]) => ({ price, shares }));
}
