import {
  scaleAgeStripGhostHalfLife,
  scaleAgeStripVolumePerCssPixel,
} from "@/lib/ageStripTuning";
import { normalizedWheelDelta } from "./ageStripLayout";

/**
 * Apply the age-view tuning gestures shared by ordinary events and series.
 *
 * Ctrl+wheel changes pressure/share scale.
 * Shift+wheel changes ghost half-life.
 *
 * Returns true when the gesture was consumed.
 */
export function handleAgeStripTuningWheel(event: WheelEvent): boolean {
  if (!event.ctrlKey && !event.shiftKey) return false;

  const factor = Math.exp(-normalizedWheelDelta(event) * 0.002);
  if (event.shiftKey) scaleAgeStripGhostHalfLife(factor);
  else scaleAgeStripVolumePerCssPixel(factor);

  return true;
}
