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

interface RelativeTimeUnit {
  readonly suffix: "ms" | "s" | "m" | "h" | "d" | "mo";
  readonly seconds: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
  /** Smallest displayed increment in this unit. */
  readonly quantumSeconds: number;
}

const RELATIVE_TIME_UNITS: readonly RelativeTimeUnit[] = [
  {
    suffix: "ms",
    seconds: 0.001,
    minSeconds: 0,
    maxSeconds: 1,
    quantumSeconds: 0.001,
  },
  {
    suffix: "s",
    seconds: 1,
    minSeconds: 1,
    maxSeconds: 60,
    quantumSeconds: 0.01,
  },
  {
    suffix: "m",
    seconds: 60,
    minSeconds: 60,
    maxSeconds: 3_600,
    quantumSeconds: 0.6,
  },
  {
    suffix: "h",
    seconds: 3_600,
    minSeconds: 3_600,
    maxSeconds: 86_400,
    quantumSeconds: 36,
  },
  {
    suffix: "d",
    seconds: 86_400,
    minSeconds: 86_400,
    maxSeconds: 30 * 86_400,
    quantumSeconds: 864,
  },
  {
    suffix: "mo",
    seconds: 30 * 86_400,
    minSeconds: 30 * 86_400,
    maxSeconds: Infinity,
    quantumSeconds: 25_920,
  },
];

/**
 * Format a relative duration using one best-fit unit and at most two decimal
 * places:
 *
 *   610ms, 3.4s, 52s, 4.38m, 2.25h, ...
 *
 * Elapsed timers floor to the current display quantum so they never claim time
 * that has not happened yet. Remaining timers ceil for the inverse reason.
 * The returned redraw deadline is the next point where the rendered text (or
 * selected unit) can change.
 *
 * Month labels remain approximate 30-day buckets because this helper receives
 * only an interval, not calendar endpoints.
 */
export function relativeTimeDisplay(
  seconds: number,
  direction: RelativeTimeDirection = "elapsed",
): RelativeTimeDisplay {
  const clamped = Math.max(
    0,
    Number.isFinite(seconds) ? seconds : 0,
  );
  if (direction === "remaining" && clamped <= 0)
    return { text: "due", nextChangeMs: null };

  const unit =
    RELATIVE_TIME_UNITS.find(
      (candidate) => clamped < candidate.maxSeconds,
    ) ?? RELATIVE_TIME_UNITS.at(-1)!;

  const quantum = unit.quantumSeconds;
  const scaled = clamped / quantum;
  const ticks =
    direction === "elapsed"
      ? Math.floor(scaled + 1e-9)
      : Math.ceil(scaled - 1e-9);
  const representedSeconds = Math.max(0, ticks * quantum);

  let nextChangeSeconds: number;
  if (direction === "elapsed") {
    const nextQuantumBoundary = (ticks + 1) * quantum;
    nextChangeSeconds =
      Math.min(nextQuantumBoundary, unit.maxSeconds) - clamped;
  } else {
    const previousQuantumBoundary = Math.max(
      0,
      (ticks - 1) * quantum,
    );
    nextChangeSeconds =
      clamped -
      Math.max(previousQuantumBoundary, unit.minSeconds);
  }

  return {
    text: formatRelativeTimeInUnit(representedSeconds, unit),
    nextChangeMs:
      Number.isFinite(nextChangeSeconds) && nextChangeSeconds > 0
        ? nextChangeSeconds * 1000
        : 1,
  };
}

/** Human-readable elapsed duration. */
export function fmtRelativeTime(seconds: number): string {
  return relativeTimeDisplay(seconds, "elapsed").text;
}

function formatRelativeTimeInUnit(
  seconds: number,
  unit: RelativeTimeUnit,
): string {
  if (unit.suffix === "ms")
    return `${Math.max(0, Math.round(seconds * 1000))}ms`;

  const value = seconds / unit.seconds;
  const rounded = Math.round(value * 100) / 100;
  return `${formatMaxTwoDecimals(rounded)}${unit.suffix}`;
}

function formatMaxTwoDecimals(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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
