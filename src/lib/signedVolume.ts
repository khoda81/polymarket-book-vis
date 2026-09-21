import { canonicalSpread, type TokenBook } from "./orderBook";

export interface SignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  /** Signed cumulative shares: bids are positive, asks are negative. */
  readonly volume: number;
  /**
   * Capital needed to sweep the resting pressure represented by this segment.
   *
   * Positive/bid pressure is consumed by selling YES into bids, which is
   * equivalent to buying NO at `1 - bidPrice`. Negative/ask pressure is
   * consumed by buying YES at `askPrice`.
   */
  readonly sweepCost: number;
}

export interface SignedVolumeColorScale {
  readonly luminance: number;
  /** Default chroma used when a side-specific chroma is not provided. */
  readonly chroma: number;
  readonly positiveHue: number;
  readonly negativeHue: number;
  readonly positiveLuminance?: number;
  readonly negativeLuminance?: number;
  readonly positiveChroma?: number;
  readonly negativeChroma?: number;
}

/**
 * Shared sign palette. Magnitude is deliberately absent from this scale:
 * signed pressure magnitude is represented by vertical ink area, while hue
 * communicates only direction.
 */
export const DEFAULT_SIGNED_VOLUME_COLOR_SCALE: SignedVolumeColorScale = {
  luminance: 0.7,
  chroma: 0.15,
  positiveHue: 190,
  negativeHue: 305,
};

/**
 * Build the signed cumulative pressure field across probability space.
 *
 * Moving left-to-right, bid liquidity is removed as its limit price is
 * crossed, then ask liquidity accumulates negatively as ask prices are
 * crossed. The spread itself therefore has zero signed resting volume and
 * zero sweep cost.
 *
 * `sweepCost` is side-aware but unsigned: on the bid side it is the cost of
 * the equivalent NO position required to wipe those bids; on the ask side it
 * is the USD cost of buying the cumulative YES asks. Keeping it next to the
 * cumulative shares lets the renderer derive Kelly-optimal conviction rather
 * than choosing an arbitrary volume transfer function.
 */
export function signedVolumeSegments(
  book: TokenBook<unknown>,
): readonly SignedVolumeSegment[] {
  const changes = new Map<number, { volume: number; sweepCost: number }>();
  const spread = canonicalSpread(book);
  const hasOpenSpread = spread.bid < spread.ask;
  let volume = 0;
  let sweepCost = 0;

  const addChange = (price: number, volumeDelta: number, costDelta: number) => {
    const previous = changes.get(price) ?? { volume: 0, sweepCost: 0 };
    changes.set(price, {
      volume: previous.volume + volumeDelta,
      sweepCost: previous.sweepCost + costDelta,
    });
  };

  for (const order of book.usdToYes.asOrders()) {
    if (order.price < 0 || order.price > 1 || order.take <= 0) continue;
    const noCost = (1 - order.price) * order.take;
    volume += order.take;
    sweepCost += noCost;
    addChange(order.price, -order.take, -noCost);
  }

  for (const order of book.yesToUsd.asSellOrders()) {
    if (order.price < 0 || order.price > 1 || order.take <= 0) continue;
    const yesCost = order.price * order.take;
    addChange(order.price, -order.take, yesCost);
  }

  const result: SignedVolumeSegment[] = [];
  let cursor = 0;
  for (const [price, delta] of [...changes].sort(([a], [b]) => a - b)) {
    if (price > cursor)
      result.push({ lo: cursor, hi: price, volume, sweepCost });
    volume += delta.volume;
    sweepCost += delta.sweepCost;

    // The bid field ends exactly at the best bid. Do not rely on floating-point
    // cancellation of many bid deltas to manufacture the empty spread.
    if (hasOpenSpread && price === spread.bid) {
      volume = 0;
      sweepCost = 0;
    }
    cursor = price;
  }
  if (cursor < 1) result.push({ lo: cursor, hi: 1, volume, sweepCost });
  if (result.length === 0)
    result.push({ lo: 0, hi: 1, volume: 0, sweepCost: 0 });
  return result;
}

/** Full-strength CSS color for the sign of a pressure value. */
export function signedVolumeColor(
  volume: number,
  scale: SignedVolumeColorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): string {
  if (volume === 0 || Number.isNaN(volume)) return "transparent";
  const negative = volume < 0;
  const hue = negative ? scale.negativeHue : scale.positiveHue;
  const luminance = negative
    ? (scale.negativeLuminance ?? scale.luminance)
    : (scale.positiveLuminance ?? scale.luminance);
  const chroma = negative
    ? (scale.negativeChroma ?? scale.chroma)
    : (scale.positiveChroma ?? scale.chroma);
  return `oklch(${luminance} ${chroma} ${hue})`;
}
