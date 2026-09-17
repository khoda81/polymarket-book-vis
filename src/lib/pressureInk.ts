export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;
export const DIFFUSION_VARIANCE_PER_TIME_SCALE = 8;

/**
 * Soft-saturating fraction of one row occupied by fresh pressure.
 *
 *   0 volume        -> 0
 *   softLimit       -> 1/2 row
 *   infinite volume -> full row
 */
export function pressureInkAreaFraction(volume: number, softLimit: number): number {
  validatePositiveFinite(softLimit, "volume soft limit");
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return 1;
  const magnitude = Math.abs(volume);
  return magnitude / (magnitude + softLimit);
}

/**
 * Unbounded bloom energy carried by pressure beyond the base half-row scale.
 *
 * `rowHeightCss * volumePerCssPixel` is the base renderer's half-row volume.
 * Bloom starts only above that scale. `asinh` stays approximately linear near
 * the threshold but grows logarithmically without ever saturating.
 */
export function pressureBloomEnergy(
  volume: number,
  volumePerCssPixel: number,
  rowHeightCss: number,
): number {
  validatePositiveFinite(volumePerCssPixel, "volume per pixel");
  validatePositiveFinite(rowHeightCss, "row height");
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return Infinity;

  const softLimit = volumePerCssPixel * rowHeightCss;
  const excess = Math.max(Math.abs(volume) / softLimit - 1, 0);
  return Math.asinh(excess);
}

/**
 * Convert signed volume into fresh vertical ink thickness in CSS pixels.
 *
 * `volumePerCssPixel` preserves the intuitive small-signal scale of the linear
 * renderer. The corresponding soft limit is the volume that would have filled
 * one complete row linearly: `rowHeightCss * volumePerCssPixel`. At that volume
 * the saturating renderer occupies half the row rather than clipping.
 */
export function pressureInkThicknessCss(
  volume: number,
  volumePerCssPixel: number = DEFAULT_VOLUME_PER_CSS_PIXEL,
  rowHeightCss: number,
): number {
  validatePositiveFinite(volumePerCssPixel, "volume per pixel");
  validatePositiveFinite(rowHeightCss, "row height");
  const softLimit = volumePerCssPixel * rowHeightCss;
  return rowHeightCss * pressureInkAreaFraction(volume, softLimit);
}

/** Standard deviation accumulated by diffusion over `ageMs`. */
export function diffusionSigmaCss(
  ageMs: number,
  timeScaleSeconds: number,
): number {
  validatePositiveFinite(timeScaleSeconds, "diffusion time scale");
  if (ageMs === Infinity) return Infinity;
  if (!Number.isFinite(ageMs) || ageMs < 0)
    throw new RangeError("diffusion age must be non-negative or Infinity");

  return Math.sqrt(
    DIFFUSION_VARIANCE_PER_TIME_SCALE *
      (ageMs / 1000) /
      timeScaleSeconds,
  );
}

/**
 * Rasterize one pressure value into a vertically diffused row profile.
 *
 * Fresh pressure is a centered top-hat whose row-area fraction is
 * `abs(volume) / (abs(volume) + rowHeight * volumePerCssPixel)`. This agrees
 * with the previous linear volume-per-pixel mapping near zero but saturates
 * smoothly instead of hard-clipping. Fractional physical-pixel coverage
 * naturally represents subpixel area. For finite age the top-hat is convolved
 * with the heat kernel, so diffusion redistributes the same ink mass until row
 * clipping lets old haze dissipate out of view.
 */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  volumePerCssPixel: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array {
  validatePositiveFinite(dpr, "device pixel ratio");
  if (!Number.isInteger(deviceHeight) || deviceHeight < 1)
    throw new RangeError("device row height must be a positive integer");

  const profile = new Float32Array(deviceHeight);
  if (ageMs === Infinity || volume === 0 || Number.isNaN(volume)) return profile;

  const rowHeightCss = deviceHeight / dpr;
  const thicknessCss = pressureInkThicknessCss(
    volume,
    volumePerCssPixel,
    rowHeightCss,
  );
  const thicknessDevice = Math.min(deviceHeight, thicknessCss * dpr);
  if (!(thicknessDevice > 0)) return profile;

  const sigmaDevice = diffusionSigmaCss(ageMs, timeScaleSeconds) * dpr;
  const center = profileCenterDevice(deviceHeight);
  if (!(sigmaDevice >= 0.05)) {
    rasterFreshTopHat(profile, thicknessDevice, center);
    return profile;
  }

  const halfThickness = thicknessDevice / 2;
  for (let y = 0; y < deviceHeight; y++) {
    const dy = y + 0.5 - center;
    const upper = normalCdf((dy + halfThickness) / sigmaDevice);
    const lower = normalCdf((dy - halfThickness) / sigmaDevice);
    profile[y] = clamp01(upper - lower);
  }
  return profile;
}

function rasterFreshTopHat(
  profile: Float32Array,
  thicknessDevice: number,
  center: number,
): void {
  const lo = center - thicknessDevice / 2;
  const hi = center + thicknessDevice / 2;

  for (let y = 0; y < profile.length; y++) {
    const overlap = Math.min(y + 1, hi) - Math.max(y, lo);
    if (overlap > 0) profile[y] = Math.min(1, overlap);
  }
}

/** Pick one stable physical center pixel even when the row height is even. */
function profileCenterDevice(deviceHeight: number): number {
  return Math.floor((deviceHeight - 1) / 2) + 0.5;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

// Abramowitz-Stegun 7.1.26; comfortably more accurate than an 8-bit target.
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial =
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - polynomial * Math.exp(-x * x));
}

function validatePositiveFinite(value: number, name: string): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError(`${name} must be finite and positive`);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
