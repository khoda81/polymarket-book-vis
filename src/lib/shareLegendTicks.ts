import { fmtSIAtExponent } from "./math";
import { tickDensityOpacity } from "./tickPlacement/density";
import { placeQuantileTicks } from "./tickPlacement/quantileTicks";

export interface ShareLegendTick {
  readonly value: number;
  readonly position: number;
  readonly opacity: number;
  /** Engineering decade chosen by the tick family for display. */
  readonly displayExponent: number;
  readonly label: string;
}

export interface ShareLegendTickOptions {
  readonly minSpacingPx: number;
  readonly fullOpacitySpacingPx: number;
  readonly dpr: number;
}

/**
 * QBar-style ticks for the signed share-pressure transform:
 *
 *   s = q / (|q| + reserve)
 *   x = 1/2 + s/2
 *
 * Placement is delegated to the same quantile-only raster algorithm used by
 * the ghost-memory axis. The share-specific pieces are only this quantile,
 * the nested 1 / 0.5 decade refinement chain, and label formatting.
 */
export function shareLegendTicks(
  reserve: number,
  widthPx: number,
  options: ShareLegendTickOptions,
): readonly ShareLegendTick[] {
  if (!(reserve > 0) || !Number.isFinite(reserve)) return [];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [];

  const pixelCount = Math.round(widthPx * options.dpr);
  const minSpacingRasterPx = Math.round(options.minSpacingPx * options.dpr);
  const quantile = (position: number): number =>
    shareValueAtPosition(position, reserve);

  const centerPixel = Math.floor(pixelCount / 2);
  const centerLeft = quantile(centerPixel / pixelCount);
  const centerRight = quantile((centerPixel + 1) / pixelCount);
  const finestVisibleStep = (centerRight - centerLeft) * minSpacingRasterPx;
  const leftVisible = quantile(1 / pixelCount);
  const rightVisible = quantile((pixelCount - 1) / pixelCount);
  const maxMagnitude = Math.max(Math.abs(leftVisible), Math.abs(rightVisible));

  const placements = placeQuantileTicks({
    pixelCount,
    minSpacingPx: minSpacingRasterPx,
    quantile,
    refinementSteps: shareRefinementSteps(maxMagnitude, finestVisibleStep),
  });

  return placements
    .map((placement): ShareLegendTick => {
      const opacity = tickDensityOpacity(
        placement.densityPx / options.dpr,
        options.minSpacingPx,
        options.fullOpacitySpacingPx,
      );
      const exponent = Math.ceil(Math.log10(placement.step));
      const displayExponent = engineeringExponent(exponent);
      return {
        value: placement.value,
        position: placement.position,
        opacity,
        displayExponent,
        label: formatShareTick(placement.value, displayExponent),
      };
    })
    .filter((tick) => tick.opacity > 1 / 255);
}

export function shareLegendPosition(value: number, reserve: number): number {
  if (!(reserve > 0) || !Number.isFinite(reserve)) return 0.5;
  if (Number.isNaN(value) || value === 0) return 0.5;

  const signed = Number.isFinite(value)
    ? value / (Math.abs(value) + reserve)
    : Math.sign(value);
  return 0.5 + 0.5 * signed;
}

export function shareValueAtPosition(
  position: number,
  reserve: number,
): number {
  if (position === 0) return Number.NEGATIVE_INFINITY;
  if (position === 1) return Number.POSITIVE_INFINITY;

  const signed = 2 * position - 1;
  if (signed === 0) return 0;

  const magnitude = (reserve * Math.abs(signed)) / (1 - Math.abs(signed));
  return Math.sign(signed) * magnitude;
}

export function shareRefinementSteps(
  maxMagnitude: number,
  finestVisibleStep: number,
): readonly number[] {
  const maxExponent = Math.ceil(Math.log10(maxMagnitude));
  const minExponent = Math.floor(Math.log10(finestVisibleStep)) - 1;
  const steps: number[] = [];

  for (let exponent = maxExponent; exponent >= minExponent; exponent--) {
    steps.push(10 ** exponent);
    steps.push(0.5 * 10 ** exponent);
  }

  return steps;
}

function engineeringExponent(exponent: number): number {
  return Math.floor(exponent / 3) * 3;
}

function formatShareTick(value: number, displayExponent: number): string {
  if (value === 0) return "0";
  const magnitude = fmtSIAtExponent(Math.abs(value), displayExponent);
  return `${value > 0 ? "+" : "−"}${magnitude}`;
}
