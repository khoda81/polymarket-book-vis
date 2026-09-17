export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;
export const DIFFUSION_VARIANCE_PER_TIME_SCALE = 8;

/**
 * Convert absolute signed volume into vertical opaque-pixel-equivalents.
 *
 * One CSS pixel of fully opaque ink represents `volumePerCssPixel` YES. The
 * fresh stripe is centered in its row and clips only when it fills the row.
 */
export function pressureInkThicknessCss(
  volume: number,
  volumePerCssPixel: number = DEFAULT_VOLUME_PER_CSS_PIXEL,
  rowHeightCss = Infinity,
): number {
  validatePositiveFinite(volumePerCssPixel, "volume per pixel");
  if (!(rowHeightCss > 0) || Number.isNaN(rowHeightCss))
    throw new RangeError("row height must be positive");
  if (volume === 0 || Number.isNaN(volume)) return 0;

  const raw = Number.isFinite(volume)
    ? Math.abs(volume) / volumePerCssPixel
    : Infinity;
  return Math.min(raw, rowHeightCss);
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
 * The fresh profile is a centered top-hat whose integral in CSS pixels is
 * `abs(volume) / volumePerCssPixel`, clipped to the row height. Fractional
 * device-pixel coverage naturally represents subpixel volume. For finite age
 * the top-hat is convolved with the heat kernel, so diffusion redistributes the
 * same ink mass until row clipping lets old haze dissipate out of view.
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

  const thicknessCss = pressureInkThicknessCss(
    volume,
    volumePerCssPixel,
    deviceHeight / dpr,
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
