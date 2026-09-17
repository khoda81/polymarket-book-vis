import type { SignedVolumeSegment } from "./signedVolume";

/**
 * Return the parts of the previous sharp pressure field that were displaced by
 * a newer book state.
 *
 * Both inputs are cumulative step fields over [0, 1]. Resin only needs the
 * visual quantity (signed shares), so a cost-only change is deliberately not a
 * historical deposit. Unchanged pressure is also omitted: websocket update
 * frequency must not make a stationary book grow brighter over time.
 */
export function displacedPressureSegments(
  previous: readonly SignedVolumeSegment[],
  next: readonly SignedVolumeSegment[],
): SignedVolumeSegment[] {
  if (previous.length === 0 || next.length === 0) return [];

  const result: SignedVolumeSegment[] = [];
  let previousIndex = 0;
  let nextIndex = 0;

  while (previousIndex < previous.length && nextIndex < next.length) {
    const before = previous[previousIndex]!;
    const after = next[nextIndex]!;
    const lo = Math.max(before.lo, after.lo);
    const hi = Math.min(before.hi, after.hi);

    if (
      hi > lo &&
      before.volume !== 0 &&
      !approximatelyEqual(before.volume, after.volume)
    ) {
      pushMerged(result, { ...before, lo, hi });
    }

    if (before.hi <= after.hi) previousIndex++;
    if (after.hi <= before.hi) nextIndex++;
  }

  return result;
}

/**
 * Reproject a normalized pressure radius between two share-reserve scales.
 *
 * The sharp mapping is h = Q / (Q + C). Given a radius h_new in the new
 * coordinate system, this returns the radius h_old that represents the same
 * underlying share threshold Q in the old coordinate system:
 *
 *   Q = C_new h_new / (1 - h_new)
 *   h_old = Q / (Q + C_old)
 *
 * This lets the GPU vertically warp already-diffused resin when Ctrl-scroll
 * changes C, instead of leaving history stranded at its previous thickness.
 */
export function reprojectPressureFraction(
  newFraction: number,
  oldReserve: number,
  newReserve: number,
): number {
  if (!(oldReserve > 0) || !(newReserve > 0))
    throw new RangeError("share reserves must be positive");
  if (!(newFraction > 0)) return 0;
  if (newFraction >= 1) return 1;

  const numerator = newReserve * newFraction;
  return numerator / (numerator + oldReserve * (1 - newFraction));
}

function pushMerged(
  result: SignedVolumeSegment[],
  segment: SignedVolumeSegment,
): void {
  const previous = result[result.length - 1];
  if (
    previous &&
    approximatelyEqual(previous.hi, segment.lo) &&
    approximatelyEqual(previous.volume, segment.volume) &&
    approximatelyEqual(previous.sweepCost, segment.sweepCost)
  ) {
    result[result.length - 1] = { ...previous, hi: segment.hi };
    return;
  }
  result.push(segment);
}

function approximatelyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-10 * scale;
}
