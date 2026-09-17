export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;
export const DIFFUSION_VARIANCE_PER_TIME_SCALE = 8;

/**
 * Soft normalization of cumulative share pressure.
 *
 * `reserveShares` is the share count C that maps to half of the row:
 *
 *   pressure = |Q| / (|Q| + C)
 *
 * This deliberately gives up additive area semantics in exchange for local
 * legibility: a very deep book far from the spread can no longer flatten small
 * but important near-spread liquidity everywhere else on the dashboard.
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

/** Convert a share-pressure sample into fresh vertical ink thickness. */
export function pressureInkThicknessCss(
  volume: number,
  reserveShares: number,
  rowHeightCss: number,
): number {
  validatePositiveFinite(rowHeightCss, "row height");
  return rowHeightCss * sharePressureAreaFraction(volume, reserveShares);
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

/** Canvas/reference signature: C is derived from YES-per-pixel × row height. */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  volumePerCssPixel: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array;

/**
 * WebGL compatibility signature. `shareReference` is intentionally ignored;
 * the renderer still passes it while the abandoned dashboard-wide scale is
 * being removed. `reserveShares` alone controls the local soft mapping.
 */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  shareReference: number,
  reserveShares: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array;

/**
 * Rasterize pressure into a vertically diffused row profile.
 *
 * Each output sample is the integral over a physical pixel rather than a point
 * sample, so subpixel ink remains continuous as the blur approaches zero.
 */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  third: number,
  fourth: number,
  fifth: number,
  sixth: number,
  seventh?: number,
): Float32Array {
  let reserveShares: number;
  let timeScaleSeconds: number;
  let dpr: number;
  let deviceHeight: number;

  if (seventh === undefined) {
    const volumePerCssPixel = third;
    timeScaleSeconds = fourth;
    dpr = fifth;
    deviceHeight = sixth;
    validatePositiveFinite(volumePerCssPixel, "volume per pixel");
    validateRasterInputs(dpr, deviceHeight);
    reserveShares = volumePerCssPixel * (deviceHeight / dpr);
  } else {
    // `third` is the obsolete dashboard-wide share reference.
    reserveShares = fourth;
    timeScaleSeconds = fifth;
    dpr = sixth;
    deviceHeight = seventh;
    validatePositiveFinite(reserveShares, "share reserve");
    validateRasterInputs(dpr, deviceHeight);
  }

  const rowHeightCss = deviceHeight / dpr;
  const thicknessCss = pressureInkThicknessCss(
    volume,
    reserveShares,
    rowHeightCss,
  );
  return rasterPressureProfile(
    thicknessCss,
    ageMs,
    timeScaleSeconds,
    dpr,
    deviceHeight,
  );
}

function rasterPressureProfile(
  thicknessCss: number,
  ageMs: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array {
  const profile = new Float32Array(deviceHeight);
  if (ageMs === Infinity || !(thicknessCss > 0)) return profile;

  const thicknessDevice = Math.min(deviceHeight, thicknessCss * dpr);
  if (!(thicknessDevice > 0)) return profile;

  const sigmaDevice = diffusionSigmaCss(ageMs, timeScaleSeconds) * dpr;
  const center = profileCenterDevice(deviceHeight);
  if (!(sigmaDevice >= 1e-6)) {
    rasterFreshTopHat(profile, thicknessDevice, center);
    return profile;
  }

  const halfThickness = thicknessDevice / 2;
  for (let y = 0; y < deviceHeight; y++) {
    const pixelLo = y - center;
    const pixelHi = y + 1 - center;
    profile[y] = clamp01(
      integratedBlurredTopHat(
        pixelLo,
        pixelHi,
        halfThickness,
        sigmaDevice,
      ),
    );
  }
  return profile;
}

function integratedBlurredTopHat(
  pixelLo: number,
  pixelHi: number,
  halfThickness: number,
  sigma: number,
): number {
  const primitive = (x: number) => normalCdfPrimitive(x, sigma);
  return (
    primitive(pixelHi + halfThickness) -
    primitive(pixelLo + halfThickness) -
    primitive(pixelHi - halfThickness) +
    primitive(pixelLo - halfThickness)
  );
}

/** Antiderivative of Φ(x / sigma). */
function normalCdfPrimitive(x: number, sigma: number): number {
  const z = x / sigma;
  return x * normalCdf(z) + sigma * normalPdf(z);
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

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
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

function validateRasterInputs(dpr: number, deviceHeight: number): void {
  validatePositiveFinite(dpr, "device pixel ratio");
  if (!Number.isInteger(deviceHeight) || deviceHeight < 1)
    throw new RangeError("device row height must be a positive integer");
}

function validatePositiveFinite(value: number, name: string): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError(`${name} must be finite and positive`);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
