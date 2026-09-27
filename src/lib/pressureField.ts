export type PressureSide = -1 | 1;

export const PRESSURE_MIN_VISIBLE_ALPHA = 1 / 255;

export interface PressureBand {
  readonly loVolume: number;
  readonly hiVolume: number;
  /** Latest instant through which this observation is known to be valid. */
  readonly validThroughMs: number;
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
