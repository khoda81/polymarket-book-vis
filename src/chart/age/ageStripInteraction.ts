import type { AgeStripTuningStore } from "@/chart/age/ageStripTuningStore";
import { normalizedWheelDelta } from "./ageStripLayout";

interface PendingTuningScale {
  volumeLogScale: number;
  ghostLogScale: number;
  raf: number | null;
}

const pendingByTuning = new WeakMap<AgeStripTuningStore, PendingTuningScale>();

function pendingScale(tuning: AgeStripTuningStore): PendingTuningScale {
  let pending = pendingByTuning.get(tuning);
  if (!pending) {
    pending = { volumeLogScale: 0, ghostLogScale: 0, raf: null };
    pendingByTuning.set(tuning, pending);
  }
  return pending;
}

/**
 * Apply the age-view tuning gestures shared by ordinary events and series.
 *
 * Ctrl+wheel changes pressure/share scale.
 * Shift+wheel changes ghost half-life.
 *
 * Touchpads can deliver many wheel events between display frames. Accumulate
 * their multiplicative scale in log space per visualization scope and publish
 * at most once per animation frame.
 *
 * Returns true when the gesture was consumed.
 */
export function handleAgeStripTuningWheel(
  event: WheelEvent,
  tuning: AgeStripTuningStore,
): boolean {
  if (!event.ctrlKey && !event.shiftKey) return false;

  const pending = pendingScale(tuning);
  const logScale = -normalizedWheelDelta(event) * 0.002;
  if (event.shiftKey) pending.ghostLogScale += logScale;
  else pending.volumeLogScale += logScale;

  if (pending.raf === null)
    pending.raf = requestAnimationFrame(() => {
      pending.raf = null;

      const volumeFactor = Math.exp(pending.volumeLogScale);
      const ghostFactor = Math.exp(pending.ghostLogScale);
      pending.volumeLogScale = 0;
      pending.ghostLogScale = 0;

      tuning.scale(volumeFactor, ghostFactor);
    });

  return true;
}
