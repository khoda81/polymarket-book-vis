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

export function hslColor(idx: bigint): string {
  const hue = (idx * BigInt(275)) % 360n;
  return `hsl(${hue}, 70%, 50%)`;
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
