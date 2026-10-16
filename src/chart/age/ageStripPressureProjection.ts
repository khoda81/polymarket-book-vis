import type { PressureExtent } from "@/domain/pressure/pressureField";
import type { PressureRun } from "@/domain/pressure/pressureFrontierSnapshot";
import type { Price } from "@/domain/books/price";
import { shareVolumeAtPressure } from "@/rendering/colors/pressureInk";
import type { GpuPressureSurface } from "./gpuPressureLayer";
import { barYDirection, type PressureBar } from "./pressureRows";

/** Render-ready history of one track, independent of how a bar presents it. */
export interface TrackRenderData {
  readonly dataRevision: number;
  readonly maxPrice: Price;
  readonly runs: readonly PressureRun[];
  readonly cumulativeShares: readonly number[];
  readonly firstChangedRunSince: (revision: number) => number;
  readonly currentValidThroughMs: number | undefined;
  readonly extents: readonly PressureExtent[];
  readonly extentRevision: number;
}

/**
 * Surfaces are keyed by track: buffer uploads depend only on track data, so
 * bars drawing the same track share one GPU buffer.
 */
export function barPressureSurface(
  bar: PressureBar,
  track: TrackRenderData,
): GpuPressureSurface {
  return {
    key: bar.track,
    ...track,
    color: bar.color,
    mirrorPrice: bar.priceAxis === "descending",
    yDirection: barYDirection(bar),
  };
}

/**
 * Invert the renderer's v/sqrt(v^2 + s^2) vertical projection.
 *
 * Returns null at/outside the asymptote (the outer row boundary), where no
 * finite cumulative liquidity coordinate exists.
 */
export function pressureVolumeAtY(
  yCss: number,
  centerCss: number,
  sideHeightCss: number,
  reserveShares: number,
): number | null {
  if (!(sideHeightCss > 0) || !(reserveShares > 0)) return null;

  const pressure = Math.abs(yCss - centerCss) / sideHeightCss;
  if (!(pressure >= 0) || pressure >= 1) return null;

  return shareVolumeAtPressure(pressure, reserveShares);
}
