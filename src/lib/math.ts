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

  xAt(ratio: number): number {
    const pts = this.pts;
    if (!pts.length) return -Infinity;
    let lo = 0;
    let hi = pts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].ratio < ratio) lo = mid;
      else hi = mid;
    }
    return pts[lo].total;
  }

  ratioAt(total: number): number {
    const pts = this.pts;
    if (!pts.length) return -Infinity;
    let lo = 0;
    let hi = pts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].total < total) lo = mid;
      else hi = mid;
    }
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

  insert(pt: Step): MarketCurve {}
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
