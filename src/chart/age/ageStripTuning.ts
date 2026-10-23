import { stalenessAgeForOpacityErrorMs } from "../../domain/pressure/pressureField";
import { MAX_TIMER_DELAY_MS } from "../../shared/timers";
export const AGE_ROW_BAND_PX = 32;
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
    return MAX_TIMER_DELAY_MS;

  return Math.min(MAX_TIMER_DELAY_MS, ghostOpacityBucketDelayMs(halfLifeMs));
}
