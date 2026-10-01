import { PRICE_ONE, PRICE_ZERO, type Price } from "../books/price";

export type PressureSide = -1 | 1;

export const PRESSURE_MIN_VISIBLE_ALPHA = 1 / 255;

export interface PressureBand {
  readonly loVolume: number;
  readonly hiVolume: number;
  /** Latest instant through which this observation is known to be valid. */
  readonly validThroughMs: number;
}

export type PressureVolumeUpperBound =
  | { readonly kind: "finite"; readonly shares: number }
  | { readonly kind: "unbounded" };

export type PressureValidity =
  | { readonly kind: "through"; readonly validThroughMs: number }
  | { readonly kind: "persistent" };

/**
 * A rectangular extent in the token-local (price, cumulative-volume) field.
 * Unlike recorder bands, an extent may be unbounded in volume or persistent
 * in time. These are mathematical properties, not lifecycle annotations.
 */
export interface PressureExtent {
  readonly priceLo: Price;
  readonly priceHi: Price;
  readonly loVolume: number;
  readonly hiVolume: PressureVolumeUpperBound;
  readonly validity: PressureValidity;
}

export interface PressureFieldBand {
  readonly loVolume: number;
  readonly hiVolume: PressureVolumeUpperBound;
  readonly validity: PressureValidity;
}

export const FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT: PressureExtent = {
  priceLo: PRICE_ZERO,
  priceHi: PRICE_ONE,
  loVolume: 0,
  hiVolume: { kind: "unbounded" },
  validity: { kind: "persistent" },
};

export function pressureExtentContains(
  extent: PressureExtent,
  price: Price,
  volume: number,
): boolean {
  if (price < extent.priceLo || price > extent.priceHi) return false;
  if (volume < extent.loVolume) return false;
  return (
    extent.hiVolume.kind === "unbounded" || volume < extent.hiVolume.shares
  );
}

export function pressureValidityAlpha(
  validity: PressureValidity,
  nowMs: number,
  halfLifeMs: number,
): number {
  return validity.kind === "persistent"
    ? 1
    : stalenessAlpha(validity.validThroughMs, nowMs, halfLifeMs);
}

export function visibleSinceMs(
  nowMs: number,
  halfLifeMs: number,
  minAlpha = 1 / 255,
): number {
  validateHalfLife(halfLifeMs);
  if (!(minAlpha >= 0 && minAlpha < 1))
    throw new RangeError("min alpha must be in [0, 1)");
  if (minAlpha === 0) return Number.NEGATIVE_INFINITY;

  const maxVisibleAgeMs = (-Math.log(minAlpha) / Math.LN2) * halfLifeMs;
  return nowMs - maxVisibleAgeMs;
}

export function stalenessAlpha(
  validThroughMs: number,
  nowMs: number,
  halfLifeMs: number,
): number {
  validateHalfLife(halfLifeMs);
  const ageMs = Math.max(0, nowMs - validThroughMs);
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

/**
 * Maximum unconfirmed age before treating a fully fresh pixel as stale would
 * introduce the requested absolute alpha error.
 */
export function stalenessAgeForOpacityErrorMs(
  halfLifeMs: number,
  maxOpacityError: number,
): number {
  validateHalfLife(halfLifeMs);
  if (!(maxOpacityError > 0 && maxOpacityError < 1))
    throw new RangeError("opacity error must be in (0, 1)");

  return (-Math.log1p(-maxOpacityError) / Math.LN2) * halfLifeMs;
}

function validateHalfLife(value: number): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError("half-life must be finite and positive");
}
