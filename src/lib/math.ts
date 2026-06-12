export interface Point {
  x: number;
  y: number;
}

export function fmtVol(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
}

export function fmtUsd(v: number): string {
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(2) + "k";
  return "$" + v.toFixed(2);
}

/**
 * Compute dynamic Y-axis tick positions as powers of 10.
 * Returns fractions in (0, 1] relative to yMax.
 */
export function powerOf10Ticks(yMax: number, targetCount = 5): number[] {
  if (yMax <= 0) return [];
  const rough = yMax / targetCount;
  const exp = Math.floor(Math.log10(rough));
  const candidates = [1, 2, 5].map((m) => m * Math.pow(10, exp));
  const step = candidates.reduce((best, c) => {
    const n = Math.floor(yMax / c);
    return Math.abs(n - targetCount) <
      Math.abs(Math.floor(yMax / best) - targetCount)
      ? c
      : best;
  });
  const ticks: number[] = [];
  for (let v = step; v <= yMax * 1.001; v += step) ticks.push(v / yMax);
  return ticks;
}

export function hslColor(idx: number): string {
  const hue = (idx * 137.5) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

/**
 * A monotone step curve with y ≥ 0.
 *
 * Internally stores points in normalized form (positive y ascending).
 * The `sign` field tracks whether this is an ask-side (+1) or bid-side (-1)
 * curve, so callers never need to manually negate.
 */
export class Curve {
  readonly pts: Point[];
  readonly sign: 1 | -1;

  constructor(pts: Point[], sign: 1 | -1 = 1) {
    this.sign = sign;
    // Normalize: store y as absolute values so the curve is always y ≥ 0 ascending
    this.pts = sign === -1 ? pts.map(({ x, y }) => ({ x, y: -y })) : pts;
  }

  get length(): number {
    return this.pts.length;
  }

  /** Total volume (the last y value in the normalized curve). */
  get total(): number {
    return this.pts.length ? this.pts[this.pts.length - 1].y : 0;
  }

  /** Read the signed y-value at a given price x. */
  volumeAt(price: number): number {
    return this.sign * this.yAtX(price);
  }

  /** Read the absolute y-value at a given price x. */
  yAtX(x: number): number {
    const pts = this.pts;
    if (!pts.length) return 0;
    if (x <= pts[0].x) return pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].x >= x) return pts[i - 1].y;
    }
    return pts[pts.length - 1].y;
  }

  /** Find the next price level after `x` (for rectangle width). */
  nextPriceAfter(x: number): number {
    for (let i = 1; i < this.pts.length; i++) {
      if (this.pts[i].x > x) return this.pts[i].x;
    }
    return 1;
  }

  /**
   * Slice the curve to only include points with y ≤ maxY,
   * appending an interpolated endpoint exactly at maxY.
   */
  sliceToY(maxY: number): Point[] {
    const out: Point[] = [];
    for (const pt of this.pts) {
      if (pt.y <= maxY) {
        out.push(pt);
      } else {
        const prev = out[out.length - 1] ?? pt;
        const dy = pt.y - prev.y;
        const t = dy === 0 ? 0 : (maxY - prev.y) / dy;
        out.push({ x: prev.x + t * (pt.x - prev.x), y: maxY });
        return out;
      }
    }
    out.push({ x: this.pts[this.pts.length - 1].x, y: maxY });
    return out;
  }

  /**
   * Compute USD cost to take `shares` through this curve.
   * Area = ∫ x dy  (Riemann sum over the staircase segments).
   */
  takeCost(shares: number): number {
    if (shares <= 0) return 0;
    const sliced = this.sliceToY(shares);
    let area = 0;
    for (let i = 1; i < sliced.length; i++) {
      area += sliced[i - 1].x * (sliced[i].y - sliced[i - 1].y);
    }
    return area;
  }

  /**
   * Iterate over the points in signed form (original y values).
   * Useful for drawing on the canvas where y < 0 is below the zero line.
   */
  *signedPoints(): Generator<Point> {
    for (const pt of this.pts) {
      yield { x: pt.x, y: this.sign * pt.y };
    }
  }

  /** Get all points in signed form as an array. */
  signedArray(): Point[] {
    return this.pts.map(({ x, y }) => ({ x, y: this.sign * y }));
  }

  /** Get points in signed form, reversed. */
  signedReversed(): Point[] {
    return this.pts.map(({ x, y }) => ({ x, y: this.sign * y })).reverse();
  }

  /**
   * Find the center x of the zero-crossing region.
   * In the normalized curve, "zero crossing" means the first point (y=0 region).
   */
  zeroCrossingCenter(): number | null {
    const zPts = this.pts.filter((p) => p.y === 0);
    if (!zPts.length) return null;
    if (zPts.length === 1) return zPts[0].x;
    return (zPts[0].x + zPts[zPts.length - 1].x) / 2;
  }
}

/**
 * Compute USD area between two ask-side curves sliced to the same y level.
 * Area = ∫ (xR - xL) dy  (Riemann sum over the staircase segments).
 */
export function calculateArea(sliceL: Point[], sliceR: Point[]): number {
  const ys = [
    ...new Set([...sliceL.map((p) => p.y), ...sliceR.map((p) => p.y)]),
  ].sort((a, b) => a - b);

  function xAtY(curve: Point[], y: number): number | null {
    if (!curve.length) return null;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].y >= y) {
        const dy = curve[i].y - curve[i - 1].y;
        if (dy === 0) return curve[i - 1].x;
        return (
          curve[i - 1].x +
          ((y - curve[i - 1].y) / dy) * (curve[i].x - curve[i - 1].x)
        );
      }
    }
    return curve[curve.length - 1].x;
  }

  let area = 0;
  for (let i = 1; i < ys.length; i++) {
    const yMid = (ys[i - 1] + ys[i]) / 2;
    const xL = xAtY(sliceL, yMid) ?? 0;
    const xR = xAtY(sliceR, yMid) ?? 1;
    area += (xR - xL) * (ys[i] - ys[i - 1]);
  }
  return area;
}
