import { pressureInkThicknessCss } from "@/lib/pressureInk";
import { stalenessAlpha, type PressureBand } from "@/lib/pressureField";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface RasterShell {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly alpha: number;
  readonly color: RgbColor;
}

export interface PressureColumnRasterOptions {
  readonly positiveColor: RgbColor;
  readonly negativeColor: RgbColor;
  readonly reserveShares: number;
  readonly rowHeightCss: number;
  readonly dpr: number;
  readonly ghostHalfLifeMs: number;
  readonly nowMs: number;
  readonly visibleSinceMs: number;
  readonly centerDevice: number;
  readonly topDevice: number;
  readonly heightDevice: number;
}

/**
 * Rasterize an already-disjoint semantic pressure shell stack.
 *
 * PressureFrontierMemory guarantees that radial shells do not overlap. We can
 * therefore integrate color/opacity over each physical device pixel directly;
 * there is no nested source-over correction and geometric coverage is charged
 * exactly once.
 */
export function rasterizePressureBandsInto(
  bands: readonly PressureBand[],
  options: PressureColumnRasterOptions,
  result: Uint8ClampedArray,
): void {
  const height = Math.max(0, Math.floor(options.heightDevice));
  const byteLength = height * 4;
  if (result.length < byteLength)
    throw new RangeError("pressure raster buffer is too small");

  result.fill(0, 0, byteLength);
  if (height === 0 || bands.length === 0) return;

  const shells = buildRasterShells(bands, options);
  if (shells.length === 0) return;

  for (let row = 0; row < height; row++) {
    const lo = options.topDevice + row - options.centerDevice;
    const hi = lo + 1;

    let premulR = 0;
    let premulG = 0;
    let premulB = 0;
    let alpha = 0;

    for (const shell of shells) {
      const coverage = symmetricShellOverlap(
        lo,
        hi,
        shell.innerRadius,
        shell.outerRadius,
      );
      if (!(coverage > 0)) continue;

      const contribution = coverage * shell.alpha;
      premulR += shell.color.r * contribution;
      premulG += shell.color.g * contribution;
      premulB += shell.color.b * contribution;
      alpha += contribution;
    }

    if (!(alpha > 0)) continue;
    const offset = row * 4;
    result[offset] = Math.round(255 * clamp01(premulR / alpha));
    result[offset + 1] = Math.round(255 * clamp01(premulG / alpha));
    result[offset + 2] = Math.round(255 * clamp01(premulB / alpha));
    result[offset + 3] = Math.round(255 * clamp01(alpha));
  }
}

function buildRasterShells(
  bands: readonly PressureBand[],
  options: PressureColumnRasterOptions,
): RasterShell[] {
  const shells: RasterShell[] = [];

  for (const band of bands) {
    if (band.validThroughMs <= options.visibleSinceMs) continue;

    const alpha = stalenessAlpha(
      band.validThroughMs,
      options.nowMs,
      options.ghostHalfLifeMs,
    );
    if (!(alpha > 1 / 255)) continue;

    const innerRadius =
      (pressureInkThicknessCss(
        band.loVolume,
        options.reserveShares,
        options.rowHeightCss,
      ) *
        options.dpr) /
      2;
    const outerRadius =
      (pressureInkThicknessCss(
        band.hiVolume,
        options.reserveShares,
        options.rowHeightCss,
      ) *
        options.dpr) /
      2;
    if (!(outerRadius > innerRadius)) continue;

    shells.push({
      innerRadius,
      outerRadius,
      alpha,
      color: band.side < 0 ? options.negativeColor : options.positiveColor,
    });
  }

  return shells;
}

function symmetricShellOverlap(
  lo: number,
  hi: number,
  innerRadius: number,
  outerRadius: number,
): number {
  return (
    intervalOverlap(lo, hi, innerRadius, outerRadius) +
    intervalOverlap(lo, hi, -outerRadius, -innerRadius)
  );
}

function intervalOverlap(
  lo: number,
  hi: number,
  intervalLo: number,
  intervalHi: number,
): number {
  return Math.max(0, Math.min(hi, intervalHi) - Math.max(lo, intervalLo));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
