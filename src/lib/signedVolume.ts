import type { TokenBook } from "./orderBook";

export interface SignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
}

export interface SignedVolumeColorScale {
  readonly luminance: number;
  readonly chroma: number;
  readonly positiveHue: number;
  readonly negativeHue: number;
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
 * Build the signed cumulative field across probability space.
 *
 * Moving left-to-right, bid liquidity is removed as its limit price is
 * crossed, then ask liquidity accumulates negatively as ask prices are
 * crossed. The spread itself therefore has zero signed resting volume.
 */
export function signedVolumeSegments(
  book: TokenBook<unknown>,
): readonly SignedVolumeSegment[] {
  const changes = new Map<number, number>();
  let volume = 0;

  for (const order of book.usdToYes.asOrders()) {
    if (order.price < 0 || order.price > 1 || order.take <= 0) continue;
    volume += order.take;
    changes.set(order.price, (changes.get(order.price) ?? 0) - order.take);
  }

  for (const order of book.yesToUsd.asSellOrders()) {
    if (order.price < 0 || order.price > 1 || order.take <= 0) continue;
    changes.set(order.price, (changes.get(order.price) ?? 0) - order.take);
  }

  const result: SignedVolumeSegment[] = [];
  let cursor = 0;
  for (const [price, delta] of [...changes].sort(([a], [b]) => a - b)) {
    if (price > cursor) result.push({ lo: cursor, hi: price, volume });
    volume += delta;
    cursor = price;
  }
  if (cursor < 1) result.push({ lo: cursor, hi: 1, volume });
  if (result.length === 0) result.push({ lo: 0, hi: 1, volume: 0 });
  return result;
}

/** Full-strength CSS color for the sign of a pressure value. */
export function signedVolumeColor(
  volume: number,
  scale: SignedVolumeColorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): string {
  if (volume === 0 || Number.isNaN(volume)) return "transparent";
  const hue = volume < 0 ? scale.negativeHue : scale.positiveHue;
  return `oklch(${scale.luminance} ${scale.chroma} ${hue})`;
}
