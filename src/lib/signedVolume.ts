import type { TokenBook } from "./orderBook";

export interface SignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
}

export interface SignedVolumeColorScale {
  /** Absolute volume mapped halfway from neutral to full chroma. */
  readonly softLimit: number;
  readonly luminance: number;
  readonly chroma: number;
  readonly positiveHue: number;
  readonly negativeHue: number;
}

/**
 * Shared by every chart so equal signed volumes always have equal colors.
 * Teal and violet are deliberately valence-neutral: neither reads as
 * good/bad in the way a red/green diverging scale tends to.
 */
export const DEFAULT_SIGNED_VOLUME_COLOR_SCALE: SignedVolumeColorScale = {
  softLimit: 10_000,
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

/**
 * Map signed volume onto [0, 1] without an arbitrary hard maximum.
 *
 *   0 volume          -> 0.5 (neutral)
 *   +softLimit        -> 0.75
 *   -softLimit        -> 0.25
 *   +/- infinity      -> 1 / 0
 *
 * `softLimit` is therefore an intuitive half-saturation parameter. Changing
 * it rescales every market without changing ordering or introducing a clip.
 */
export function signedVolumePosition(
  volume: number,
  softLimit: number = DEFAULT_SIGNED_VOLUME_COLOR_SCALE.softLimit,
): number {
  if (!(softLimit > 0) || !Number.isFinite(softLimit))
    throw new RangeError("signed volume soft limit must be finite and positive");
  if (Number.isNaN(volume) || volume === 0) return 0.5;

  const signed = Number.isFinite(volume)
    ? volume / (Math.abs(volume) + softLimit)
    : Math.sign(volume);
  return 0.5 + 0.5 * signed;
}

/** Inverse of signedVolumePosition for finite positions inside (0, 1). */
export function signedVolumeAtPosition(
  position: number,
  softLimit: number = DEFAULT_SIGNED_VOLUME_COLOR_SCALE.softLimit,
): number {
  if (!(softLimit > 0) || !Number.isFinite(softLimit))
    throw new RangeError("signed volume soft limit must be finite and positive");
  const p = Math.max(0, Math.min(1, position));
  const signed = 2 * p - 1;
  if (signed === 0) return 0;
  if (Math.abs(signed) >= 1) return Math.sign(signed) * Infinity;
  return Math.sign(signed) * softLimit * Math.abs(signed) / (1 - Math.abs(signed));
}

export function signedVolumeColorAtPosition(
  position: number,
  scale: SignedVolumeColorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): string {
  const signed = 2 * Math.max(0, Math.min(1, position)) - 1;
  const chroma = Math.abs(signed) * scale.chroma;
  const hue = signed < 0 ? scale.negativeHue : scale.positiveHue;
  return `oklch(${scale.luminance} ${chroma} ${hue})`;
}

export function signedVolumeColor(
  volume: number,
  scale: SignedVolumeColorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): string {
  return signedVolumeColorAtPosition(
    signedVolumePosition(volume, scale.softLimit),
    scale,
  );
}
