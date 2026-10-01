/**
 * Smooth visibility from local projected tick spacing.
 *
 * All three distances are required: callers own the presentation policy.
 */
export function tickDensityOpacity(
  spacingPx: number,
  minSpacingPx: number,
  fullOpacitySpacingPx: number,
): number {
  const x = Math.max(
    0,
    Math.min(
      1,
      (spacingPx - minSpacingPx) / (fullOpacitySpacingPx - minSpacingPx),
    ),
  );
  return x * x * (3 - 2 * x);
}
