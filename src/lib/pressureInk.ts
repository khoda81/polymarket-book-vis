export const DEFAULT_VOLUME_PER_CSS_PIXEL = 10_000;
export const DIFFUSION_VARIANCE_PER_TIME_SCALE = 8;

/**
 * Area-preserving normalization of cumulative share pressure.
 *
 * `shareReference` is a common upper reference V for every pressure field in
 * the current dashboard and `reserveShares` is the user-controlled headroom C.
 * With D = V + C, pressure is simply
 *
 *   pressure = |Q| / D
 *
 * so the transformation is linear in shares at every price. That linearity is
 * the important property: integrating the normalized bar over probability and
 * multiplying by D preserves the economically meaningful share×price area.
 * The maximum observed share depth V reaches V/(V+C), retaining the visual
 * softness of v/(v+c) without applying a nonlinear transform point-by-point.
 */
export function sharePressureAreaFraction(
  volume: number,
  shareReference: number,
  reserveShares: number,
): number {
  validateNonNegativeFinite(shareReference, "share reference");
  validatePositiveFinite(reserveShares, "share reserve");
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return 1;

  const denominator = shareReference + reserveShares;
  return clamp01(Math.abs(volume) / denominator);
}

/** Convert a share-pressure sample into fresh vertical ink thickness. */
export function pressureInkThicknessCss(
  volume: number,
  shareReference: number,
  reserveShares: number,
  rowHeightCss: number,
): number {
  validatePositiveFinite(rowHeightCss, "row height");
  return (
    rowHeightCss *
    sharePressureAreaFraction(volume, shareReference, reserveShares)
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
 * Legacy Canvas2D signature. It retains the previous local soft-share mapping
 * until the fallback renderer is migrated to the dashboard-wide share scale.
 */
export function pressureInkProfile(
  volume: number,
  ageMs: number,
  volumePerCssPixel: number,
  timeScaleSeconds: number,
  dpr: number,
  deviceHeight: number,
): Float32Array;

/** Area-preserving share-pressure signature used by the WebGL path. */
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
 * The seven-argument form uses one common linear share scale, so bar area is
 * proportional to the integral of cumulative shares over price. Each output
 * sample is the *integral over a physical pixel*, not the value at its center;
 * this conserves subpixel ink continuously as sigma tends to zero.
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
  if (seventh === undefined) {
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

  const shareReference = third;
  const reserveShares = fourth;
  const timeScaleSeconds = fifth;
  const dpr = sixth;
  const deviceHeight = seventh;
  validateRasterInputs(dpr, deviceHeight);

  const rowHeightCss = deviceHeight / dpr;
  const thicknessCss = pressureInkThicknessCss(
    volume,
    shareReference,
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

function validateNonNegativeFinite(value: number, name: string): void {
  if (value < 0 || !Number.isFinite(value))
    throw new RangeError(`${name} must be finite and non-negative`);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
