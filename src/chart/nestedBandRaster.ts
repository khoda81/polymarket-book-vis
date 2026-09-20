export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface NestedRasterLayer {
  /** Half thickness in device pixels. Layers must be ordered outer to inner. */
  readonly halfThickness: number;
  /** Source alpha before geometric coverage is applied. */
  readonly alpha: number;
  readonly color: RgbColor;
}

interface PremultipliedColor extends RgbColor {
  readonly a: number;
}

interface RasterShell {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly color: PremultipliedColor;
}

/**
 * Analytically rasterize a centered stack of nested translucent bands.
 *
 * The important distinction from drawing each rectangle directly is that
 * geometric coverage is integrated only after the layers have been composited
 * at each exact point. Two subpixel nested bands therefore cannot both charge
 * the same pixel for coverage that physically overlaps.
 */
export function rasterizeNestedBands(
  layers: readonly NestedRasterLayer[],
  centerDevice: number,
  topDevice: number,
  heightDevice: number,
): Uint8ClampedArray {
  const height = Math.max(0, Math.floor(heightDevice));
  const result = new Uint8ClampedArray(height * 4);
  if (height === 0 || layers.length === 0) return result;

  const shells = buildShells(layers);
  if (shells.length === 0) return result;

  for (let row = 0; row < height; row++) {
    const lo = topDevice + row - centerDevice;
    const hi = lo + 1;

    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const shell of shells) {
      const coverage = symmetricShellOverlap(
        lo,
        hi,
        shell.innerRadius,
        shell.outerRadius,
      );
      if (!(coverage > 0)) continue;

      r += shell.color.r * coverage;
      g += shell.color.g * coverage;
      b += shell.color.b * coverage;
      a += shell.color.a * coverage;
    }

    if (!(a > 0)) continue;
    const offset = row * 4;
    result[offset] = Math.round(255 * clamp01(r / a));
    result[offset + 1] = Math.round(255 * clamp01(g / a));
    result[offset + 2] = Math.round(255 * clamp01(b / a));
    result[offset + 3] = Math.round(255 * clamp01(a));
  }

  return result;
}

function buildShells(
  layers: readonly NestedRasterLayer[],
): RasterShell[] {
  const envelopes: {
    readonly radius: number;
    readonly color: PremultipliedColor;
  }[] = [];

  let composite: PremultipliedColor = { r: 0, g: 0, b: 0, a: 0 };
  let previousRadius = Number.POSITIVE_INFINITY;

  for (const layer of layers) {
    const alpha = clamp01(layer.alpha);
    if (!(alpha > 0) || !(layer.halfThickness > 0)) continue;

    const radius = Math.min(previousRadius, layer.halfThickness);
    if (!(radius > 0)) continue;

    composite = sourceOver(layer.color, alpha, composite);
    envelopes.push({
      radius,
      color: composite,
    });
    previousRadius = radius;
  }

  return envelopes.flatMap((envelope, index) => {
    const innerRadius = envelopes[index + 1]?.radius ?? 0;
    if (!(envelope.radius > innerRadius)) return [];
    return [{
      innerRadius,
      outerRadius: envelope.radius,
      color: envelope.color,
    }];
  });
}

function sourceOver(
  source: RgbColor,
  alpha: number,
  destination: PremultipliedColor,
): PremultipliedColor {
  const inverse = 1 - alpha;
  return {
    r: source.r * alpha + destination.r * inverse,
    g: source.g * alpha + destination.g * inverse,
    b: source.b * alpha + destination.b * inverse,
    a: alpha + destination.a * inverse,
  };
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
