export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;

/**
 * Smooth signed normalization of cumulative share pressure.
 *
 * Geometrically, this is the signed volume component divided by the length of
 * the orthogonal vector (reserveShares, volume):
 *
 *   pressure = Q / sqrt(Q^2 + R^2)
 *
 * The result is odd, smooth through zero, and asymptotically approaches ±1.
 */
export function signedSharePressure(
  volume: number,
  reserveShares: number,
): number {
  validatePositiveFinite(reserveShares, "share reserve");
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return Math.sign(volume);

  return volume / Math.hypot(volume, reserveShares);
}

/**
 * Invert signedSharePressure().
 *
 * ±1 are the asymptotic edges and therefore correspond to unbounded volume.
 */
export function shareVolumeAtPressure(
  pressure: number,
  reserveShares: number,
): number {
  validatePositiveFinite(reserveShares, "share reserve");
  if (pressure === 0 || Number.isNaN(pressure)) return 0;
  if (pressure <= -1) return Number.NEGATIVE_INFINITY;
  if (pressure >= 1) return Number.POSITIVE_INFINITY;

  return (reserveShares * pressure) / Math.sqrt(1 - pressure * pressure);
}

/** Unsigned row-space magnitude of cumulative share pressure. */
export function sharePressureAreaFraction(
  volume: number,
  reserveShares: number,
): number {
  return Math.abs(signedSharePressure(volume, reserveShares));
}

/** Convert cumulative shares into sharp vertical bar thickness. */
export function pressureInkThicknessCss(
  volume: number,
  reserveShares: number,
  rowHeightCss: number,
): number {
  validatePositiveFinite(rowHeightCss, "row height");
  return rowHeightCss * sharePressureAreaFraction(volume, reserveShares);
}

function validatePositiveFinite(value: number, name: string): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError(`${name} must be finite and positive`);
}
