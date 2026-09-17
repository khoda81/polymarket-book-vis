import type { Range } from "./transform";

/** Minimum pixel spacing between adjacent automatic axis ticks. */
const MIN_TICK_SPACING_PX = 40;

/**
 * Compute "nice" axis tick values across `range`, sized to fit `pixelSize`.
 *
 * Steps are always 1, 2, or 5 × 10^n so labels stay clean. The count is bounded
 * by `pixelSize / minSpacing`; returned values are absolute positions.
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
  const step = [1, 2, 5, 10]
    .map((multiplier) => multiplier * base)
    .find((candidate) => Math.floor(span / candidate) <= maxTicks)!;

  const ticks: number[] = [];
  const start = Math.ceil(range.min / step) * step;
  for (let value = start; value <= range.max + step * 1e-6; value += step)
    ticks.push(value);
  return ticks;
}

/** Human-readable relative duration without decimal minute/hour ticks. */
export function fmtRelativeTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  if (clamped === 0) return "0s";
  if (clamped < 1) return `${Math.round(clamped * 1000)}ms`;
  if (clamped < 60) {
    const value = Math.round(clamped * 10) / 10;
    return `${value}s`;
  }

  const rounded = Math.round(clamped);
  if (rounded < 3600) {
    const minutes = Math.floor(rounded / 60);
    const secondsPart = rounded % 60;
    return secondsPart ? `${minutes}m ${secondsPart}s` : `${minutes}m`;
  }

  if (rounded < 86_400) {
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const days = Math.floor(rounded / 86_400);
  const hours = Math.floor((rounded % 86_400) / 3600);
  return hours ? `${days}d ${hours}h` : `${days}d`;
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
 * Within an event, sequential markets are spaced by the golden angle in hue.
 * The event id shifts the whole palette so equal indices in different events
 * do not all start from the same color.
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
