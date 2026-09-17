/** Minimum center-to-center spacing between signed-volume legend labels. */
export const MIN_VOLUME_LEGEND_TICK_DISTANCE_PX = 48;

// Decimal tick families, ordered from strongest to weakest preference. Keep the
// 1× decade marks first, then half-decades, then 2× subdivisions. This mirrors
// the QBar idea that tick niceness has a hierarchy rather than one fixed step.
const NICE_TICK_FAMILIES = [1, 5, 2] as const;
const EXPONENT_RADIUS = 12;

/** Soft-saturating signed-volume position across the legend. */
export function volumeLegendPosition(value: number, softLimit: number): number {
  if (!(softLimit > 0) || !Number.isFinite(softLimit)) return 0.5;
  if (Number.isNaN(value) || value === 0) return 0.5;
  const signed = Number.isFinite(value)
    ? value / (Math.abs(value) + softLimit)
    : Math.sign(value);
  return 0.5 + 0.5 * signed;
}

/**
 * Select symmetric "nice" ticks for the soft-saturating area legend.
 *
 * Candidates are considered family-by-family and largest-first. A ± pair is
 * accepted only when both labels remain at least `minDistancePx` from every
 * already selected tick. Zero is always the highest-priority tick. Since the
 * scale approaches ±infinity at the ends, the largest candidate is derived
 * from the edge padding rather than from an arbitrary finite maximum.
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

  const maxSigned = Math.max(
    0,
    Math.min(1 - Number.EPSILON, 1 - (2 * edgePadding) / widthPx),
  );
  if (!(maxSigned > 0)) return [0];
  const maxMagnitude = softLimit * maxSigned / (1 - maxSigned);
  const baseExponent = Math.floor(Math.log10(maxMagnitude));

  for (const multiplier of NICE_TICK_FAMILIES) {
    const magnitudes = Array.from(
      { length: EXPONENT_RADIUS * 2 + 1 },
      (_, index) => multiplier * 10 ** (baseExponent - EXPONENT_RADIUS + index),
    )
      .filter((value) => value > 0 && value <= maxMagnitude)
      .sort((a, b) => b - a);

    for (const magnitude of magnitudes) {
      const pair = [-magnitude, magnitude].map((value) => ({
        value,
        x: volumeLegendPosition(value, softLimit) * widthPx,
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
