export interface QuantileTickPlacementOptions {
  /** Number of discrete raster pixels across the axis. */
  readonly pixelCount: number;
  /** Required search-bucket width in the same raster-pixel units. */
  readonly minSpacingPx: number;
  /**
   * Monotone quantile function from normalized screen boundary [0, 1] to the
   * represented value. q(1) may be +Infinity for asymptotic transforms.
   */
  readonly quantile: (position: number) => number;
  /**
   * Coarse-to-fine refinement chain. Every finer step must divide its coarser
   * predecessor exactly, so each coarse grid is a subset of every finer grid.
   * The first step crossing a search interval wins that interval.
   */
  readonly refinementSteps: readonly number[];
}

export interface QuantileTickPlacement {
  readonly value: number;
  readonly step: number;
  /** Raster pixel whose represented half-open value interval owns the tick. */
  readonly pixel: number;
  /** Center of the owning pixel, normalized to [0, 1). */
  readonly position: number;
  /**
   * Local projected spacing estimate in raster pixels, derived only from the
   * value interval represented by the owning pixel.
   */
  readonly densityPx: number;
}

/**
 * Place ticks using only a monotone quantile function.
 *
 * Search buckets and raster pixels both own half-open value ranges:
 * [q(left), q(right)). A value exactly on a shared boundary therefore belongs
 * to the interval on its right, with no equality/tolerance special case.
 */
export function placeQuantileTicks({
  pixelCount,
  minSpacingPx,
  quantile,
  refinementSteps,
}: QuantileTickPlacementOptions): readonly QuantileTickPlacement[] {
  const bucketCount = Math.ceil(pixelCount / minSpacingPx);
  const pixelBoundaryValues = new Array<number | undefined>(pixelCount + 1);
  const valueAtPixelBoundary = (pixel: number): number => {
    const cached = pixelBoundaryValues[pixel];
    if (cached !== undefined) return cached;
    const value = quantile(pixel / pixelCount);
    pixelBoundaryValues[pixel] = value;
    return value;
  };

  const bucketValues = new Array<number>(bucketCount + 1);
  for (let boundary = 0; boundary <= bucketCount; boundary++) {
    const pixel = Math.min(boundary * minSpacingPx, pixelCount);
    bucketValues[boundary] = valueAtPixelBoundary(pixel);
  }

  const ticks: QuantileTickPlacement[] = [];

  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const leftPixel = bucket * minSpacingPx;
    const rightPixel = Math.min(leftPixel + minSpacingPx, pixelCount);
    const startValue = bucketValues[bucket]!;
    const endValue = bucketValues[bucket + 1]!;

    const crossing = findCoarsestCrossing(
      startValue,
      endValue,
      refinementSteps,
    );
    if (crossing === null) continue;

    const pixel = findOwningPixel(
      crossing.value,
      leftPixel,
      rightPixel,
      valueAtPixelBoundary,
    );
    const pixelStartValue = valueAtPixelBoundary(pixel);
    const pixelEndValue = valueAtPixelBoundary(pixel + 1);
    const representedPerPixel = pixelEndValue - pixelStartValue;
    const densityPx =
      representedPerPixel > 0 && Number.isFinite(representedPerPixel)
        ? crossing.step / representedPerPixel
        : representedPerPixel === 0
          ? Number.POSITIVE_INFINITY
          : 0;

    ticks.push({
      value: normalizeZero(crossing.value),
      step: crossing.step,
      pixel,
      position: (pixel + 0.5) / pixelCount,
      densityPx,
    });
  }

  return ticks;
}

function findCoarsestCrossing(
  startValue: number,
  endValue: number,
  refinementSteps: readonly number[],
): { readonly value: number; readonly step: number } | null {
  let lo = 0;
  let hi = refinementSteps.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const step = refinementSteps[mid]!;
    const value = firstGridValueAtOrAfter(startValue, step);
    if (value < endValue) hi = mid;
    else lo = mid + 1;
  }

  if (lo === refinementSteps.length) return null;
  const step = refinementSteps[lo]!;
  return {
    value: firstGridValueAtOrAfter(startValue, step),
    step,
  };
}

function firstGridValueAtOrAfter(value: number, step: number): number {
  let tick = Math.ceil(value / step) * step;
  if (tick < value) tick += step;
  return tick;
}

function findOwningPixel(
  value: number,
  leftPixel: number,
  rightPixel: number,
  valueAtPixelBoundary: (pixel: number) => number,
): number {
  let lo = leftPixel;
  let hi = rightPixel - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rightValue = valueAtPixelBoundary(mid + 1);
    if (value < rightValue) hi = mid;
    else lo = mid + 1;
  }

  return lo;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
