export function legendTickOpacity(
  spacingPx: number,
  minDistancePx: number,
  fadeDistancePx = minDistancePx * 2,
): number {
  if (!Number.isFinite(spacingPx) || spacingPx <= 0) return 0;
  if (!(minDistancePx > 0) || !Number.isFinite(minDistancePx)) return 1;

  if (!(fadeDistancePx > minDistancePx) || !Number.isFinite(fadeDistancePx))
    return spacingPx <= minDistancePx ? 0 : 1;

  const x = Math.max(
    0,
    Math.min(1, (spacingPx - minDistancePx) / (fadeDistancePx - minDistancePx)),
  );
  return x * x * (3 - 2 * x);
}
