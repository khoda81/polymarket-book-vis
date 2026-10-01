import { scaleAgeStripTuning } from "@/chart/age/ageStripTuning";
import { normalizedWheelDelta } from "./ageStripLayout";

let pendingVolumeLogScale = 0;
let pendingGhostLogScale = 0;
let tuningRaf: number | null = null;

/**
 * Apply the age-view tuning gestures shared by ordinary events and series.
 *
 * Ctrl+wheel changes pressure/share scale.
 * Shift+wheel changes ghost half-life.
 *
 * Touchpads can deliver many wheel events between display frames. Accumulate
 * their multiplicative scale in log space and notify all charts at most once
 * per animation frame.
 *
 * Returns true when the gesture was consumed.
 */
export function handleAgeStripTuningWheel(event: WheelEvent): boolean {
  if (!event.ctrlKey && !event.shiftKey) return false;

  const logScale = -normalizedWheelDelta(event) * 0.002;
  if (event.shiftKey) pendingGhostLogScale += logScale;
  else pendingVolumeLogScale += logScale;

  if (tuningRaf === null)
    tuningRaf = requestAnimationFrame(() => {
      tuningRaf = null;

      const volumeFactor = Math.exp(pendingVolumeLogScale);
      const ghostFactor = Math.exp(pendingGhostLogScale);
      pendingVolumeLogScale = 0;
      pendingGhostLogScale = 0;

      scaleAgeStripTuning(volumeFactor, ghostFactor);
    });

  return true;
}
