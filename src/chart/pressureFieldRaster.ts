import { pressureInkThicknessCss } from "@/lib/pressureInk";
import {
  ghostAlpha,
  type PressureBand,
} from "@/lib/pressureMemory";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface PressureColumnRasterOptions {
  readonly positiveColor: RgbColor;
  readonly negativeColor: RgbColor;
  readonly reserveShares: number;
  readonly rowHeightCss: number;
  readonly dpr: number;
  readonly ghostHalfLifeMs: number;
  readonly nowMs: number;
  readonly visibleGhostSinceMs: number;
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

  for (let row = 0; row < height; row++) {
    const lo = options.topDevice + row - options.centerDevice;
    const hi = lo + 1;

    let premulR = 0;
    let premulG = 0;
    let premulB = 0;
    let alpha = 0;

    for (const band of bands) {
      if (
        band.state.kind === "ghost" &&
        band.state.sinceMs <= options.visibleGhostSinceMs
      )
        continue;

      const bandAlpha =
        band.state.kind === "live"
          ? 1
          : ghostAlpha(
              band.state.sinceMs,
              options.nowMs,
              options.ghostHalfLifeMs,
            );
      if (!(bandAlpha > 1 / 255)) continue;

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

      const coverage = symmetricShellOverlap(
        lo,
        hi,
        innerRadius,
        outerRadius,
      );
      if (!(coverage > 0)) continue;

      const contribution = coverage * bandAlpha;
      const color =
        band.side < 0 ? options.negativeColor : options.positiveColor;
      premulR += color.r * contribution;
      premulG += color.g * contribution;
      premulB += color.b * contribution;
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
  return Math.max(
    0,
    Math.min(hi, intervalHi) - Math.max(lo, intervalLo),
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
