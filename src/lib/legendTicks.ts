import { signedVolumePosition } from "./signedVolume";

/** Minimum center-to-center spacing between signed-volume legend labels. */
export const MIN_VOLUME_LEGEND_TICK_DISTANCE_PX = 48;

// Decimal tick families, ordered from strongest to weakest preference. Keep the
// 1× decade marks first, then half-decades, then 2× subdivisions. This mirrors
// the QBar idea that tick niceness has a hierarchy rather than one fixed step.
const NICE_TICK_FAMILIES = [1, 5, 2] as const;
const EXPONENT_RADIUS = 12;

/**
 * Select symmetric "nice" signed-volume ticks for the nonlinear softsign bar.
 *
 * Candidates are considered family-by-family. Within one family, values near
 * the current half-saturation scale are considered first. A ± pair is accepted
 * only when both labels stay at least `minDistancePx` from every already chosen
 * tick. Zero is always the highest-priority tick.
 */
export function volumeLegendTickValues(
  softLimit: number,
  widthPx: number,
  minDistancePx: number = MIN_VOLUME_LEGEND_TICK_DISTANCE_PX,
): number[] {
  if (!(softLimit > 0) || !Number.isFinite(softLimit)) return [0];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [0];

  const minDistance = Math.max(0, minDistancePx);
  const edgePadding = minDistance / 2;
  const selected: { value: number; x: number }[] = [
    { value: 0, x: widthPx / 2 },
  ];
  const baseExponent = Math.floor(Math.log10(softLimit));

  for (const multiplier of NICE_TICK_FAMILIES) {
    const magnitudes = Array.from(
      { length: EXPONENT_RADIUS * 2 + 1 },
      (_, index) => multiplier * 10 ** (baseExponent - EXPONENT_RADIUS + index),
    ).sort(
      (a, b) =>
        Math.abs(Math.log10(a / softLimit)) -
          Math.abs(Math.log10(b / softLimit)) ||
        a - b,
    );

    for (const magnitude of magnitudes) {
      const pair = [-magnitude, magnitude].map((value) => ({
        value,
        x: signedVolumePosition(value, softLimit) * widthPx,
      }));

      if (
        pair.some(
          ({ x }) => x < edgePadding || x > widthPx - edgePadding,
        ) ||
        Math.abs(pair[1]!.x - pair[0]!.x) < minDistance
      ) {
        continue;
      }

      const fits = pair.every(({ x }) =>
        selected.every((tick) => Math.abs(x - tick.x) >= minDistance),
      );
      if (fits) selected.push(...pair);
    }
  }

  return selected
    .sort((a, b) => a.value - b.value)
    .map(({ value }) => value);
}
