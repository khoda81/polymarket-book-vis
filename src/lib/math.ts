import type { Range } from "./transform";

/**
 * Minimum pixel spacing between adjacent ticks. The tick count adapts to the
 * axis pixel size so ticks never crowd on small charts and never sparse on
 * large ones.
 */
const MIN_TICK_SPACING_PX = 40;

const NICE_AGE_SECONDS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10_800, 21_600, 43_200,
  86_400, 172_800, 259_200, 604_800, 1_209_600,
  2_592_000, 5_184_000, 7_776_000, 15_552_000,
  31_536_000, 63_072_000, 157_680_000,
] as const;

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

/**
 * Tick positions for an axis transformed as `log1p(seconds)`.
 *
 * Major ticks are selected from real clock durations (milliseconds, seconds,
 * whole minutes, hours, days, months, and years), then transformed. This
 * avoids inventing awkward durations by spacing ticks uniformly in transformed
 * coordinates.
 */
export function logAgeTicks(
  range: Range,
  pixelSize: number,
  minSpacing: number = MIN_TICK_SPACING_PX,
): number[] {
  const span = range.max - range.min;
  if (span <= 0 || pixelSize <= 0) return [];

  const minSeconds = Math.max(0, Math.expm1(range.min));
  const maxSeconds = Math.max(0, Math.expm1(range.max));
  const candidates: number[] = [];

  if (range.min <= 0 && range.max >= 0) candidates.push(0);

  for (const seconds of NICE_AGE_SECONDS)
    if (seconds >= minSeconds && seconds <= maxSeconds)
      candidates.push(Math.log1p(seconds));

  candidates.sort((a, b) => a - b);
  const selected: number[] = [];
  let previousPx = -Infinity;
  for (const tick of candidates) {
    const px = ((tick - range.min) / span) * pixelSize;
    if (px - previousPx < minSpacing) continue;
    selected.push(tick);
    previousPx = px;
  }

  // A tightly zoomed logarithmic interval may contain fewer than two major
  // log ticks. Locally the transform is nearly linear, so use nice durations
  // in seconds and transform those positions back onto the axis.
  if (selected.length < 2 && maxSeconds > minSeconds) {
    return axisTicks(
      { min: minSeconds, max: maxSeconds },
      pixelSize,
      minSpacing,
    ).map(Math.log1p);
  }

  return selected;
}

/** Human-readable exact relative duration without decimal minute/hour ticks. */
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
