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
 *   <1s: 1ms, <1m: 100ms, <1h: 1s, <1d: 1m,
 *   <30d: 1h, otherwise: 1d.
 *
 * Month labels are intentionally approximate 30-day buckets: this helper only
 * receives an interval, not calendar endpoints, so a calendar month is not
 * well-defined here.
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
            : clamped < 30 * 86_400
              ? { unitSeconds: 3600, rangeCeiling: 30 * 86_400 }
              : { unitSeconds: 86_400, rangeCeiling: Infinity };

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

  if (unitSeconds === 3600) {
    const totalHours = Math.floor(wholeSeconds / 3600);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }

  const totalDays = Math.floor(wholeSeconds / 86_400);
  const months = Math.floor(totalDays / 30);
  const days = totalDays % 30;
  return days ? `${months}mo ${days}d` : `${months}mo`;
}

export const MARKET_COLOR_LUMINANCE = 0.72;
export const MARKET_COLOR_CHROMA = 0.16;
const GOLDEN_ANGLE = 137.50776405003785;

export function idToHue(idx: number, offset: number = 56.234): number {
  return ((idx * GOLDEN_ANGLE + offset) % 360 + 360) % 360;
}

export function idToColor(idx: number, offset: number = 56.234): string {
  return `oklch(${MARKET_COLOR_LUMINANCE} ${MARKET_COLOR_CHROMA} ${idToHue(idx, offset)})`;
}

/**
 * Stable hue used by the ordinary per-market color identity.
 */
export function marketHue(eventId: string, marketIndex: number): number {
  const offset = parseInt(eventId) || 0;
  return idToHue(marketIndex, offset);
}

/**
 * Single source of truth for a market's color.
 *
 * Within an event, sequential markets are spaced by the golden angle in hue.
 * The event id shifts the whole palette so equal indices in different events
 * do not all start from the same color.
 */
export function marketColor(eventId: string, marketIndex: number): string {
  return `oklch(${MARKET_COLOR_LUMINANCE} ${MARKET_COLOR_CHROMA} ${marketHue(eventId, marketIndex)})`;
}

const SI_PREFIX_BY_EXPONENT = new Map<number, string>([
  [-30, "q"],
  [-27, "r"],
  [-24, "y"],
  [-21, "z"],
  [-18, "a"],
  [-15, "f"],
  [-12, "p"],
  [-9, "n"],
  [-6, "µ"],
  [-3, "m"],
  [3, "k"],
  [6, "M"],
  [9, "G"],
  [12, "T"],
  [15, "P"],
  [18, "E"],
  [21, "Z"],
  [24, "Y"],
  [27, "R"],
  [30, "Q"],
]);

/**
 * Compact SI formatting for scale labels.
 *
 * Keep the especially-readable decimal range [1e-3, 1e3) unprefixed so zooming
 * naturally walks 0.1 → 0.01 → 0.001 before switching to µ/n/p/... .
 */
export function fmtSI(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Object.is(n, -0) || n === 0) return "0";

  const sign = n < 0 ? "-" : "";
  const magnitude = Math.abs(n);

  if (magnitude >= 1e-3 && magnitude < 1e3)
    return sign + formatThreeSignificantDigits(magnitude);

  const exponent = Math.floor(Math.log10(magnitude) / 3) * 3;
  const prefix = SI_PREFIX_BY_EXPONENT.get(exponent);
  if (!prefix) return sign + magnitude.toExponential(2);

  const scaled = magnitude / 10 ** exponent;
  return sign + formatThreeSignificantDigits(scaled) + prefix;
}

function formatThreeSignificantDigits(value: number): string {
  return Number(value.toPrecision(3)).toString();
}

/** Format a volume number for display. */
export function fmtVol(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(1);
}
