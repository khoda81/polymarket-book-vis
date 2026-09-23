import type { TokenBook } from "./orderBook";
import { priceToNumber } from "./price";

export type BookHoverSide = "bid" | "ask" | "spread";

export interface BookHoverSnapshot {
  /** Mouse probability/price, clamped to [0, 1]. */
  readonly price: number;
  /** Side of the live book reached by sweeping to this price. */
  readonly side: BookHoverSide;
  /** Cumulative executable YES shares at or through this limit price. */
  readonly shares: number;
  /** Volume-weighted average YES execution price, null inside the spread. */
  readonly effectivePrice: number | null;
}

/**
 * Query executable liquidity directly from the two half-books.
 *
 * A point query has inclusive limit semantics: bids at exactly p are
 * executable when selling YES at p, and asks at exactly p are executable when
 * buying YES at p. This is intentionally independent of the half-open interval
 * convention used by the pressure renderer.
 */
export function bookHoverAtPrice(
  book: TokenBook,
  price: number,
): BookHoverSnapshot {
  const p = clamp01(price);

  let bidShares = 0;
  let bidCost = 0;
  for (const order of book.usdToYes.asOrders()) {
    if (!Number.isFinite(order.take) || order.take <= 0) continue;
    const orderPrice = priceToNumber(order.price);
    if (orderPrice < p) break;
    bidShares += order.take;
    bidCost += orderPrice * order.take;
  }
  if (bidShares > 0)
    return {
      price: p,
      side: "bid",
      shares: bidShares,
      effectivePrice: clamp01(bidCost / bidShares),
    };

  let askShares = 0;
  let askCost = 0;
  for (const order of book.yesToUsd.asSellOrders()) {
    if (!Number.isFinite(order.take) || order.take <= 0) continue;
    const orderPrice = priceToNumber(order.price);
    if (orderPrice > p) break;
    askShares += order.take;
    askCost += orderPrice * order.take;
  }
  if (askShares > 0)
    return {
      price: p,
      side: "ask",
      shares: askShares,
      effectivePrice: clamp01(askCost / askShares),
    };

  return { price: p, side: "spread", shares: 0, effectivePrice: null };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
