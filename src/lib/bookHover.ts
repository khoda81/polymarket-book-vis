import type { TokenBook } from "./orderBook";
import { signedVolumeSegments } from "./signedVolume";

export type BookHoverSide = "bid" | "ask" | "spread";

export interface BookHoverSnapshot {
  /** Mouse probability/price, clamped to [0, 1]. */
  readonly price: number;
  /** Side of the live book reached by sweeping to this price. */
  readonly side: BookHoverSide;
  /** Cumulative executable YES shares represented by the pressure field. */
  readonly shares: number;
  /** Volume-weighted average YES execution price, null inside the spread. */
  readonly effectivePrice: number | null;
}

/**
 * Read the live cumulative book at one probability coordinate.
 *
 * On the bid side, signedVolumeSegments stores the capital required to buy the
 * equivalent NO position, so the YES VWAP is `1 - noCost / shares`. On asks,
 * sweepCost is already the cumulative YES purchase cost.
 */
export function bookHoverAtPrice(
  book: TokenBook<unknown>,
  price: number,
): BookHoverSnapshot {
  const p = clamp01(price);
  const segments = signedVolumeSegments(book);
  const segment = segments.find(
    (candidate, index) =>
      p >= candidate.lo &&
      (p < candidate.hi || (index === segments.length - 1 && p <= candidate.hi)),
  );

  if (!segment || Math.abs(segment.volume) <= 1e-12) {
    return { price: p, side: "spread", shares: 0, effectivePrice: null };
  }

  const shares = Math.abs(segment.volume);
  const effectivePrice =
    segment.volume > 0
      ? 1 - segment.sweepCost / shares
      : segment.sweepCost / shares;

  return {
    price: p,
    side: segment.volume > 0 ? "bid" : "ask",
    shares,
    effectivePrice: clamp01(effectivePrice),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
