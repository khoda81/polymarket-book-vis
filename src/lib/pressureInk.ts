export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;
export const DIFFUSION_VARIANCE_PER_TIME_SCALE = 8;

/**
 * Fraction of the configured reserve consumed by sweeping one side of the book.
 *
 * `sweepCost` is the cumulative capital needed to consume the resting liquidity
 * represented by this sample. `reserveCapital` is the comparison reserve. The
 * resulting soft ratio keeps the useful shape of v/(v+c), but both numerator
 * and denominator are now expressed in dollars:
 *
 *   pressure = sweepCost / (sweepCost + reserveCapital)
 *
 * The value is in [0,1), approaches 1 asymptotically, and has the simple
 * interpretation "what fraction of sweep capital + reserve is committed to
 * crossing this much liquidity?".
 */
export function capitalPressureAreaFraction(
  volume: number,
  sweepCost: number | null,
  reserveCapital: number,
): number {
  validatePositiveFinite(reserveCapital, "reserve capital");
  if (volume === 0 || Number.isNaN(volume) || sweepCost === null) return 0;
  if (Number.isNaN(sweepCost) || sweepCost < 0) return 0;
  if (sweepCost === Infinity) return 1;
  if (!Number.isFinite(sweepCost) || sweepCost === 0) return 0;
  return sweepCost / (sweepCost + reserveCapital);
}

/** Convert a capital-pressure sample into fresh vertical ink thickness. */
export function pressureInkThicknessCss(
  volume: number,
  sweepCost: number | null,
  reserveCapital: number,
  rowHeightCss: number,
): number {
  validatePositiveFinite(rowHeightCss, "row height");
  return (
    rowHeightCss *
    capitalPressureAreaFraction(volume, sweepCost, reserveCapital)
  );
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
 * Legacy Canvas2D signature retained while the WebGL experiment is evaluated.
 * It keeps the old share-volume soft-saturation semantics in the no-WebGL
 * fallback because that call site does not yet provide sweep capital.
 */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  volumePerCssPixel: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array;

/** Capital-pressure signature used by the WebGL path. */
export function pressureInkProfile(
  volume: number,
  sweepCost: number | null,
  lo: number,
  hi: number,
  ageMs: number,
  reserveCapital: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array;

/**
 * Rasterize pressure into a vertically diffused row profile.
 *
 * The capital-pressure form derives fresh area from sweep capital relative to a
 * reserve rather than raw share count. `lo` and `hi` remain in the compatibility
 * signature for the current renderer call shape, but no longer affect magnitude.
 *
 * Each output sample is the *integral over a physical pixel*, not the value at
 * the pixel center. That conserves subpixel ink continuously as sigma tends to
 * zero and removes the one-pixel brightening discontinuity of point sampling.
 */
export function pressureInkProfile(
  volume: number,
  second: number | null,
  third: number,
  fourth: number,
  fifth: number,
  sixth: number,
  seventh?: number,
  eighth?: number,
  ninth?: number,
): Float32Array {
  if (seventh === undefined || eighth === undefined || ninth === undefined) {
    const ageMs = second as number;
    const volumePerCssPixel = third;
    const timeScaleSeconds = fourth;
    const dpr = fifth;
    const deviceHeight = sixth;
    validatePositiveFinite(volumePerCssPixel, "volume per pixel");
    validateRasterInputs(dpr, deviceHeight);

    const rowHeightCss = deviceHeight / dpr;
    const softLimit = volumePerCssPixel * rowHeightCss;
    const magnitude = Math.abs(volume);
    const fraction =
      volume === 0 || Number.isNaN(volume)
        ? 0
        : Number.isFinite(volume)
          ? magnitude / (magnitude + softLimit)
          : 1;
    return rasterPressureProfile(
      rowHeightCss * fraction,
      ageMs,
      timeScaleSeconds,
      dpr,
      deviceHeight,
    );
  }

  const sweepCost = second;
  // `third` and `fourth` are the segment price bounds retained only for call
  // compatibility; sweepCost already incorporates the prices of consumed levels.
  const ageMs = fifth;
  const reserveCapital = sixth;
  const timeScaleSeconds = seventh;
  const dpr = eighth;
  const deviceHeight = ninth;
  validateRasterInputs(dpr, deviceHeight);

  const rowHeightCss = deviceHeight / dpr;
  const thicknessCss = pressureInkThicknessCss(
    volume,
    sweepCost,
    reserveCapital,
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
