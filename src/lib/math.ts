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

export function idToColor(idx: number, offset: number = 56.234): string {
  const GOLDEN_ANGLE = 137.50776405003785;

  const L = 0.72;
  const C = 0.16;

  const hue = (idx * GOLDEN_ANGLE + offset) % 360;

  return `oklch(${L} ${C} ${hue})`;
}

/**
 * Single source of truth for a market's color.
 *
 * Within an event, sequential markets are spaced by the golden angle in hue,
 * so adjacent markets are maximally distinguishable. The event id shifts the
 * whole palette, so the same market index in different events gets a
 * different starting hue. Both the toggle dot and the chart line call this.
 */
export function marketColor(eventId: string, marketIndex: number): string {
  const offset = parseInt(eventId) || 0;
  return idToColor(marketIndex, offset);
}

/** Format a volume number for display. */
export function fmtVol(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(1);
}

/** Format a USD value for display. */
export function fmtUsd(n: number): string {
  return "$" + fmtVol(n);
}
