import { stalenessAgeForOpacityErrorMs } from "../../domain/pressure/pressureField";
import {
  AgeStripTuningStore,
  type AgeStripTuning,
} from "./ageStripTuningStore";

export const AGE_ROW_BAND_PX = 48;
const MIN_GHOST_REFRESH_MS = 33;
// Browsers clamp setTimeout to a signed 32-bit millisecond delay.
const MAX_GHOST_REFRESH_MS = 2_147_483_647;
export const GHOST_ALPHA_STEP = 1 / 255;

let store: AgeStripTuningStore | undefined;

function tuningStore(): AgeStripTuningStore {
  if (!store)
    store = new AgeStripTuningStore(
      typeof window === "undefined" ? null : window.localStorage,
    );
  return store;
}

export function getAgeStripTuning(): Readonly<AgeStripTuning> {
  return tuningStore().get();
}

export function subscribeAgeStripTuning(
  listener: (tuning: Readonly<AgeStripTuning>) => void,
): () => void {
  return tuningStore().subscribe(listener);
}

export function scaleAgeStripVolumePerCssPixel(factor: number): void {
  scaleAgeStripTuning(factor, 1);
}

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

  const delay = ghostOpacityStepDelayMs(halfLifeMs);
  return Math.min(MAX_GHOST_REFRESH_MS, Math.max(MIN_GHOST_REFRESH_MS, delay));
}

export function scaleAgeStripGhostHalfLife(factor: number): void {
  scaleAgeStripTuning(1, factor);
}

export function scaleAgeStripTuning(
  volumeFactor: number,
  ghostFactor: number,
): void {
  tuningStore().scale(volumeFactor, ghostFactor);
}
