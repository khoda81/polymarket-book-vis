export type PressureSide = -1 | 1;

export type PressureBandState =
  | { readonly kind: "live" }
  | {
      readonly kind: "ghost";
      readonly sinceMs: number;
    };

export interface PressureBand {
  readonly loVolume: number;
  readonly hiVolume: number;
  readonly side: PressureSide;
  readonly state: PressureBandState;
}

export function ghostVisibleSinceMs(
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

export function ghostAlpha(
  sinceMs: number,
  nowMs: number,
  halfLifeMs: number,
): number {
  validateHalfLife(halfLifeMs);
  const ageMs = Math.max(0, nowMs - sinceMs);
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

function validateHalfLife(value: number): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError("ghost half-life must be finite and positive");
}
