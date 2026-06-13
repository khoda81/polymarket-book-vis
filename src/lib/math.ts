export interface Step {
  total: number;
  ratio: number;
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
export class MarketCurve {
  readonly pts: Step[];

  constructor(pts: Step[]) {
    // Normalize: store y as absolute values so the curve is always y ≥ 0 ascending
    this.pts = pts;
  }

  get length(): number {
    return this.pts.length;
  }

  /**
   * Binary search: find the last index whose `key` field is < `value`.
   * Returns the segment index `lo` such that pts[lo].key <= value < pts[lo+1].key.
   */
  private findSegmentIndex<K extends keyof Step>(
    key: K,
    value: number,
  ): number {
    const pts = this.pts;
    let lo = 0;
    let hi = pts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][key] < value) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Binary search: find the lower-bound insertion index for `value` in `key`.
   * Returns the first index where pts[i].key >= value.
   */
  private lowerBoundIndex<K extends keyof Step>(key: K, value: number): number {
    const pts = this.pts;
    let lo = 0;
    let hi = pts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid][key] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Cumulative shares at a given price. */
  totalAtPrice(price: number): number {
    if (!this.pts.length) return -Infinity;
    return this.pts[this.findSegmentIndex("ratio", price)].total;
  }

  /** Price of the next step after the given price, or 1 if at the end. */
  nextPriceAfter(price: number): number {
    const pts = this.pts;
    const idx = this.lowerBoundIndex("ratio", price);
    if (idx < pts.length && pts[idx].ratio > price) return pts[idx].ratio;
    if (idx + 1 < pts.length) return pts[idx + 1].ratio;
    return 1;
  }

  /** Interpolated price at a given cumulative-share level. */
  priceAtTotal(total: number): number {
    const pts = this.pts;
    if (!pts.length) return -Infinity;
    const lo = this.findSegmentIndex("total", total);
    const hi = Math.min(lo + 1, pts.length - 1);
    return (
      pts[lo].ratio +
      ((total - pts[lo].total) / (pts[hi].total - pts[lo].total)) *
        (pts[hi].ratio - pts[lo].ratio)
    );
  }

  sliceTo(total: number): MarketCurve {
    const out: Step[] = [];
    for (const pt of this.pts) {
      if (pt.total <= total) {
        out.push(pt);
      } else {
        const prev = out[out.length - 1] ?? pt;
        const dy = pt.total - prev.total;
        const t = dy === 0 ? 0 : (total - prev.total) / dy;
        out.push({
          ratio: prev.ratio + t * (pt.ratio - prev.ratio),
          total: total,
        });
        return new MarketCurve(out);
      }
    }
    out.push({ ratio: this.pts[this.pts.length - 1].ratio, total: total });
    return new MarketCurve(out);
  }

  /**
   * Inserts a new order into the curve and returns a new MarketCurve.
   * @param pt A Step where `ratio` is the order price and `total` is the order size.
   */
  insert(pt: Step): MarketCurve {
    const price = pt.ratio;
    const size = pt.total;

    // Zero-size orders don't modify the curve
    if (size === 0) return this;

    const pts = this.pts;
    if (pts.length === 0) {
      return new MarketCurve([{ ratio: price, total: size }]);
    }

    const lo = this.lowerBoundIndex("ratio", price);

    // Copy the untouched portion of the curve
    const out = pts.slice(0, lo);
    const prevTotal = lo > 0 ? pts[lo - 1].total : 0;

    if (lo < pts.length && pts[lo].ratio === price) {
      // Exact price level exists: update this level and all subsequent ones
      for (let i = lo; i < pts.length; i++) {
        out.push({ ratio: pts[i].ratio, total: pts[i].total + size });
      }
    } else {
      // New price level: insert it, then update all subsequent ones
      out.push({ ratio: price, total: prevTotal + size });
      for (let i = lo; i < pts.length; i++) {
        out.push({ ratio: pts[i].ratio, total: pts[i].total + size });
      }
    }

    return new MarketCurve(out);
  }
}

/**
 * Compute USD area between two ask-side curves sliced to the same y level.
 * Area = ∫ (xR - xL) dy  (Riemann sum over the staircase segments).
 */
export function calculateArea(sliceL: Step[], sliceR: Step[]): number {
  const ys = [
    ...new Set([...sliceL.map((p) => p.total), ...sliceR.map((p) => p.total)]),
  ].sort((a, b) => a - b);

  function xAtY(curve: Step[], y: number): number | null {
    if (!curve.length) return null;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].total >= y) {
        const dy = curve[i].total - curve[i - 1].total;
        if (dy === 0) return curve[i - 1].ratio;
        return (
          curve[i - 1].ratio +
          ((y - curve[i - 1].total) / dy) *
            (curve[i].ratio - curve[i - 1].ratio)
        );
      }
    }
    return curve[curve.length - 1].ratio;
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
