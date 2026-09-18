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

export type RelativeTimeDirection = "elapsed" | "remaining";

export interface RelativeTimeDisplay {
  readonly text: string;
  /** Wall-clock milliseconds until this exact rendered text can change. */
  readonly nextChangeMs: number | null;
}

/**
 * Format a relative duration together with its next semantic redraw deadline.
 *
 * Elapsed timers truncate so they never claim time that has not happened yet.
 * Remaining timers ceil so a countdown never claims less time than remains.
 * The display resolution gets coarser with age:
 *
 *   <1s: 1ms, <1m: 100ms, <1h: 1s, <1d: 1m, otherwise: 1h.
 */
export function relativeTimeDisplay(
  seconds: number,
  direction: RelativeTimeDirection = "elapsed",
): RelativeTimeDisplay {
  const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (direction === "remaining" && clamped <= 0)
    return { text: "due", nextChangeMs: null };
  if (direction === "elapsed" && clamped === 0)
    return { text: "0s", nextChangeMs: 1 };

  const { unitSeconds, rangeCeiling } =
    clamped < 1
      ? { unitSeconds: 0.001, rangeCeiling: 1 }
      : clamped < 60
        ? { unitSeconds: 0.1, rangeCeiling: 60 }
        : clamped < 3600
          ? { unitSeconds: 1, rangeCeiling: 3600 }
          : clamped < 86_400
            ? { unitSeconds: 60, rangeCeiling: 86_400 }
            : { unitSeconds: 3600, rangeCeiling: Infinity };

  const scaled = clamped / unitSeconds;
  const ticks =
    direction === "elapsed"
      ? Math.floor(scaled + 1e-9)
      : Math.ceil(scaled - 1e-9);
  const representedSeconds = Math.max(0, ticks * unitSeconds);

  let nextChangeSeconds: number;
  if (direction === "elapsed") {
    const nextBoundary = (ticks + 1) * unitSeconds;
    nextChangeSeconds = Math.min(nextBoundary, rangeCeiling) - clamped;
  } else {
    const previousBoundary = Math.max(0, (ticks - 1) * unitSeconds);
    nextChangeSeconds = clamped - previousBoundary;
  }

  return {
    text: formatQuantizedRelativeTime(representedSeconds, unitSeconds),
    nextChangeMs:
      Number.isFinite(nextChangeSeconds) && nextChangeSeconds > 0
        ? nextChangeSeconds * 1000
        : null,
  };
}

/** Human-readable elapsed duration. */
export function fmtRelativeTime(seconds: number): string {
  return relativeTimeDisplay(seconds, "elapsed").text;
}

function formatQuantizedRelativeTime(
  seconds: number,
  unitSeconds: number,
): string {
  if (unitSeconds === 0.001)
    return `${Math.max(0, Math.round(seconds * 1000))}ms`;

  if (unitSeconds === 0.1) {
    const tenths = Math.max(0, Math.round(seconds * 10));
    return tenths % 10 === 0
      ? `${tenths / 10}s`
      : `${(tenths / 10).toFixed(1)}s`;
  }

  const wholeSeconds = Math.max(0, Math.round(seconds));
  if (unitSeconds === 1) {
    const minutes = Math.floor(wholeSeconds / 60);
    const secondsPart = wholeSeconds % 60;
    return secondsPart ? `${minutes}m ${secondsPart}s` : `${minutes}m`;
  }

  if (unitSeconds === 60) {
    const totalMinutes = Math.floor(wholeSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  const totalHours = Math.floor(wholeSeconds / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
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
