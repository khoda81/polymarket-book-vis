import { stalenessAgeForOpacityErrorMs } from "../../domain/pressure/pressureField";
export const AGE_ROW_BAND_PX = 48;
// Browsers clamp setTimeout to a signed 32-bit millisecond delay.
const MAX_GHOST_REFRESH_MS = 2_147_483_647;
export const GHOST_ALPHA_STEP = 1 / 255;

/**
 * Time until exponential decay changes by about one 8-bit alpha step.
 * Long half-lives therefore redraw only when the displayed alpha can change.
 */
export function ghostOpacityStepDelayMs(halfLifeMs: number): number {
  return stalenessAgeForOpacityErrorMs(halfLifeMs, GHOST_ALPHA_STEP);
}

export function ghostRefreshDelayMs(halfLifeMs: number): number {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs))
    return MAX_GHOST_REFRESH_MS;

  return Math.min(
    MAX_GHOST_REFRESH_MS,
    ghostOpacityStepDelayMs(halfLifeMs),
  );
}
