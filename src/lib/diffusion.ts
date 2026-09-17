const BASE_SIGMA_PX = 0.85;
const MAX_KERNEL_SIGMA_PX = 14;
const VARIANCE_PER_TIME_SCALE = 8;
const SIGMA_BUCKETS = 48;
const ALPHA_LEVELS = 32;
const MAX_TIMEOUT_MS = 2_147_000_000;
const MAX_CACHE_ENTRIES = 2048;

export interface DiffusionVisual {
  /** Quantized Gaussian width used for the cached kernel. */
  readonly sigmaPx: number;
  /** Quantized center alpha. The Gaussian integral is conserved before clipping. */
  readonly peakAlpha: number;
  /** Stable integer key; a redraw is only needed when this changes. */
  readonly key: number;
}

/**
 * Map evidence age to a vertically diffusing Gaussian.
 *
 * sigma² = sigma0² + k * age / timeScale
 * peak   = sigma0 / sigma
 *
 * The peak normalization keeps the un-clipped vertical ink integral constant:
 * old evidence spreads rather than simply becoming transparent. At very large
 * ages the row-band clip dissipates the visible remainder naturally.
 */
export function diffusionVisual(
  ageMs: number,
  timeScaleSeconds: number,
): DiffusionVisual {
  if (!(timeScaleSeconds > 0) || !Number.isFinite(timeScaleSeconds))
    throw new RangeError("diffusion time scale must be finite and positive");

  if (ageMs === Infinity) {
    return {
      sigmaPx: MAX_KERNEL_SIGMA_PX,
      peakAlpha: 0,
      key: SIGMA_BUCKETS * (ALPHA_LEVELS + 1),
    };
  }
  if (!Number.isFinite(ageMs) || ageMs < 0)
    throw new RangeError("diffusion age must be non-negative or Infinity");

  const ageScale = ageMs / 1000 / timeScaleSeconds;
  const rawSigma = Math.sqrt(
    BASE_SIGMA_PX * BASE_SIGMA_PX + VARIANCE_PER_TIME_SCALE * ageScale,
  );
  const cappedSigma = Math.min(rawSigma, MAX_KERNEL_SIGMA_PX);
  const sigmaBucket = Math.round(
    ((cappedSigma - BASE_SIGMA_PX) /
      (MAX_KERNEL_SIGMA_PX - BASE_SIGMA_PX)) *
      (SIGMA_BUCKETS - 1),
  );
  const sigmaPx =
    BASE_SIGMA_PX +
    (sigmaBucket / (SIGMA_BUCKETS - 1)) *
      (MAX_KERNEL_SIGMA_PX - BASE_SIGMA_PX);

  // A 32-step alpha is visually smooth at these tiny line widths but avoids
  // turning fresh evidence into a 500 Hz timer source. At the default 5 s time
  // scale the first change is ~14 ms, then updates become rapidly sparser.
  const alphaStep = Math.round(
    clamp(BASE_SIGMA_PX / rawSigma, 0, 1) * ALPHA_LEVELS,
  );

  return {
    sigmaPx,
    peakAlpha: alphaStep / ALPHA_LEVELS,
    key: sigmaBucket * (ALPHA_LEVELS + 1) + alphaStep,
  };
}

/** Find the next time the quantized diffusion appearance changes. */
export function nextDiffusionChangeDelayMs(
  ageMs: number,
  timeScaleSeconds: number,
): number {
  if (ageMs === Infinity) return Infinity;

  const currentKey = diffusionVisual(ageMs, timeScaleSeconds).key;
  let lo = 0;
  let hi = 1;

  while (
    hi < MAX_TIMEOUT_MS &&
    diffusionVisual(ageMs + hi, timeScaleSeconds).key === currentKey
  )
    hi *= 2;

  hi = Math.min(hi, MAX_TIMEOUT_MS);
  if (diffusionVisual(ageMs + hi, timeScaleSeconds).key === currentKey)
    return Infinity;

  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (diffusionVisual(ageMs + mid, timeScaleSeconds).key === currentKey)
      lo = mid;
    else hi = mid;
  }
  return hi + 0.5;
}

/**
 * Lazily cache tiny 1×H colored Gaussian sprites. Stretching one horizontally
 * is much cheaper than asking Canvas to run a general-purpose 2D blur filter
 * for every piecewise interval.
 */
export class GaussianSpriteCache {
  private readonly sprites = new Map<string, HTMLCanvasElement>();

  get(
    color: string,
    sigmaPx: number,
    dpr: number,
    bandHeightPx: number,
  ): HTMLCanvasElement {
    const targetDeviceHeight = Math.max(1, Math.round(bandHeightPx * dpr));
    // An odd raster height gives every kernel one unambiguous center pixel.
    // Even-height sprites are centered between two device pixels and can appear
    // one row higher/lower when independently composited without smoothing.
    const deviceHeight =
      targetDeviceHeight % 2 === 0 ? targetDeviceHeight + 1 : targetDeviceHeight;
    const key = `${color}|${sigmaPx.toFixed(3)}|${dpr.toFixed(3)}|${deviceHeight}`;
    const cached = this.sprites.get(key);
    if (cached) return cached;

    // Keep the cache bounded across long-running dashboards whose volume values
    // slowly explore new color buckets / device-pixel-ratio configurations.
    if (this.sprites.size >= MAX_CACHE_ENTRIES) this.sprites.clear();

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = deviceHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");

    const center = (deviceHeight - 1) / 2;
    const sigmaDevicePx = Math.max(0.01, sigmaPx * dpr);
    ctx.fillStyle = color;
    for (let y = 0; y < deviceHeight; y++) {
      const dy = (y - center) / sigmaDevicePx;
      ctx.globalAlpha = Math.exp(-0.5 * dy * dy);
      ctx.fillRect(0, y, 1, 1);
    }
    ctx.globalAlpha = 1;

    this.sprites.set(key, canvas);
    return canvas;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
