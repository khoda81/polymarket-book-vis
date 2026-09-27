import type { PressureRenderRun } from "@/lib/materializedPressureField";
import { PRICE_SCALE, priceFromTicks, type Price } from "@/lib/price";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import type { GpuPressureSurface } from "./gpuPressureLayer";

export type AgePressureSide = "primary" | "opposite";

export interface AgePressurePerspective {
  readonly side: AgePressureSide;
  /** Whether edge-local token price p is displayed at x = 1 - p. */
  readonly mirrorPrice: boolean;
  /** CSS-space direction away from the row centerline. */
  readonly yDirection: -1 | 1;
  /** Semantic color sign used by the market's signed-volume palette. */
  readonly colorSign: -1 | 1;
}

const PRIMARY: AgePressurePerspective = {
  side: "primary",
  mirrorPrice: true,
  yDirection: 1,
  colorSign: 1,
};

const OPPOSITE: AgePressurePerspective = {
  side: "opposite",
  mirrorPrice: false,
  yDirection: -1,
  colorSign: -1,
};

export function agePressurePerspective(
  side: AgePressureSide,
): AgePressurePerspective {
  return side === "primary" ? PRIMARY : OPPOSITE;
}

export function agePressureSurface(
  runs: readonly PressureRenderRun[],
  colorScale: SignedVolumeColorScale,
  side: AgePressureSide,
): GpuPressureSurface {
  const perspective = agePressurePerspective(side);
  return {
    runs,
    color: signedVolumeColor(perspective.colorSign, colorScale),
    mirrorPrice: perspective.mirrorPrice,
    yDirection: perspective.yDirection,
  };
}

export function agePressureSideAtY(
  yCss: number,
  centerCss: number,
): AgePressureSide {
  return yCss >= centerCss ? "primary" : "opposite";
}

/** Convert screen-space normalized x into this token's own price coordinate. */
export function tokenPriceAtDisplayX(
  displayPrice: number,
  perspective: AgePressurePerspective,
): number {
  const clamped = clamp01(displayPrice);
  return perspective.mirrorPrice ? 1 - clamped : clamped;
}

/** Exact-ish field lookup coordinate for a continuous screen-space price. */
export function pressurePriceAtDisplayX(
  displayPrice: number,
  perspective: AgePressurePerspective,
): Price {
  const tokenPrice = tokenPriceAtDisplayX(displayPrice, perspective);
  return priceFromTicks(
    Math.max(0, Math.min(PRICE_SCALE, Math.floor(tokenPrice * PRICE_SCALE))),
  );
}

/**
 * Invert the renderer's v/(v+s) vertical projection.
 *
 * Returns null at/outside the asymptote (the outer row boundary), where no
 * finite cumulative liquidity coordinate exists.
 */
export function pressureVolumeAtY(
  yCss: number,
  centerCss: number,
  rowHeightCss: number,
  volumePerCssPixel: number,
): number | null {
  if (!(rowHeightCss > 0) || !(volumePerCssPixel > 0)) return null;

  const halfHeight = rowHeightCss / 2;
  const pressure = Math.abs(yCss - centerCss) / halfHeight;
  if (!(pressure >= 0) || pressure >= 1) return null;

  const reserveShares = volumePerCssPixel * rowHeightCss;
  return (reserveShares * pressure) / (1 - pressure);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
