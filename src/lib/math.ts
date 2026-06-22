import type { Range } from "./transform";

/**
 * Minimum pixel spacing between adjacent ticks. The tick count adapts to the
 * axis pixel size so ticks never crowd on small charts and never sparse on
 * large ones.
 */
const MIN_TICK_SPACING_PX = 40;

/**
 * Compute "nice" axis tick values across `range`, sized to fit `pixelSize`.
 *
 * Steps are always 1, 2, or 5 × 10^n so labels stay clean. The count is bounded
 * by `pixelSize / MIN_TICK_SPACING_PX` — a 600px axis yields up to 15 ticks,
 * a 200px axis up to 5. Works for symmetric, one-sided, or arbitrary ranges;
 * returns absolute positions (not fractions of the max).
 */
export function axisTicks(
  range: Range,
  pixelSize: number,
  minSpacing: number = MIN_TICK_SPACING_PX,
): number[] {
  const span = range.max - range.min;
  if (span <= 0 || pixelSize <= 0) return [];

  const maxTicks = Math.max(1, Math.floor(pixelSize / minSpacing));
  const roughStep = span / maxTicks;
  const exp = Math.floor(Math.log10(roughStep));
  const base = Math.pow(10, exp);
  // Finest nice step (1, 2, 5, 10 × 10^n) that fits within maxTicks.
  const step = [1, 2, 5, 10]
    .map((m) => m * base)
    .find((c) => Math.floor(span / c) <= maxTicks)!;

  const ticks: number[] = [];
  // First tick >= range.min, aligned to the step grid.
  const start = Math.ceil(range.min / step) * step;
  for (let v = start; v <= range.max + step * 1e-6; v += step) ticks.push(v);
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
