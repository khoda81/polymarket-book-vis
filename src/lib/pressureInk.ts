export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;

/**
 * Soft normalization of cumulative share pressure.
 *
 * reserveShares is the share count C that maps to half of the row:
 *
 *   pressure = |Q| / (|Q| + C)
 */
export function sharePressureAreaFraction(
  volume: number,
  reserveShares: number,
): number {
  validatePositiveFinite(reserveShares, "share reserve");
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return 1;

  const magnitude = Math.abs(volume);
  return magnitude / (magnitude + reserveShares);
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
