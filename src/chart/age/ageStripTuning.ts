import { stalenessAgeForOpacityErrorMs } from "../../domain/pressure/pressureField";
export const AGE_ROW_BAND_PX = 48;
// Browsers clamp setTimeout to a signed 32-bit millisecond delay.
const MAX_GHOST_REFRESH_MS = 2_147_483_647;
export const GHOST_ALPHA_BUCKET_WIDTH = 1 / 256;

/**
 * Time until exponential decay differs by one of 256 uniform opacity buckets.
 *
 * This is an error scale, not an exact bucket-preservation schedule: exact
 * quantized rendering must schedule the next actual bucket boundary crossing.
 */
export function ghostOpacityBucketDelayMs(halfLifeMs: number): number {
  return stalenessAgeForOpacityErrorMs(halfLifeMs, GHOST_ALPHA_BUCKET_WIDTH);
}

export function ghostRefreshDelayMs(halfLifeMs: number): number {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs))
    return MAX_GHOST_REFRESH_MS;

  return Math.min(MAX_GHOST_REFRESH_MS, ghostOpacityBucketDelayMs(halfLifeMs));
}
