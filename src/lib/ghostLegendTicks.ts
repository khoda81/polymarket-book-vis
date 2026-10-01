import { legendTickOpacity } from "./legendTickDensity";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export interface GhostLegendTick {
  readonly ageMs: number;
  readonly position: number;
  readonly opacity: number;
  /** Human grid family that produced this tick; larger means coarser. */
  readonly stepMs: number;
  readonly label: string;
}

export interface GhostLegendTickOptions {
  readonly minDistancePx?: number;
  readonly fadeDistancePx?: number;
  /**
   * Local-clock offset at the left edge of the scale. Positive is in the past;
   * negative means the newest observation timestamp is ahead of local time.
   */
  readonly originAgeMs?: number;
}

/**
 * QBar-style ticks for the exponential ghost-age transform:
 *
 *   x(Δt) = 1 - 2^(-Δt / halfLife)
 *
 * Candidate grid lines live in displayed clock-offset coordinates, not in
 * relative-to-newest coordinates. Screen pixels are treated as ranges and
 * grouped at the requested minimum spacing. We invert each group boundary
 * exactly once, then choose the coarsest human grid boundary owned by that
 * half-open screen interval.
 */
export function ghostLegendTicks(
  halfLifeMs: number,
  widthPx: number,
  options: GhostLegendTickOptions = {},
): GhostLegendTick[] {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) return [];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [];

  const originAgeMs = options.originAgeMs ?? 0;
  if (!Number.isFinite(originAgeMs)) return [];

  const minDistancePx = options.minDistancePx ?? 48;
  const fadeDistancePx = options.fadeDistancePx ?? minDistancePx * 2;
  if (!(minDistancePx > 0) || !Number.isFinite(minDistancePx)) return [];

  // Search screen ranges at exactly the spacing scale we care about instead of
  // oversampling at an arbitrary fraction of a pixel. Screen ownership is
  // half-open [0, width): the final group reaches x=width, whose inverse under
  // the exponential transform is +∞.
  const groupCount = Math.max(1, Math.ceil(widthPx / minDistancePx));
  const boundaries = new Array<number>(groupCount + 1);
  for (let index = 0; index <= groupCount; index++) {
    const x = Math.min(index * minDistancePx, widthPx);
    boundaries[index] =
      x === widthPx
        ? Number.POSITIVE_INFINITY
        : originAgeMs + ageAtGhostPosition(x / widthPx, halfLifeMs);
  }

  const steps = durationSteps();
  const byAge = new Map<number, GhostLegendTick>();

  for (let group = 0; group < groupCount; group++) {
    const startAgeMs = boundaries[group]!;
    const endAgeMs = boundaries[group + 1]!;
    const includeEnd = group === groupCount - 1;
    const toleranceMs = Math.max(
      1e-9,
      Math.abs(startAgeMs) * 1e-12,
      Number.isFinite(endAgeMs) ? Math.abs(endAgeMs) * 1e-12 : 0,
    );

    // Groups own [start, end), matching raster-cell ownership: a tick exactly
    // on a shared pixel/group boundary belongs to the group on its right.
    // Only the final visible group owns its right endpoint.
    for (const stepMs of steps) {
      const ageMs = firstGridBoundaryAtOrAfter(startAgeMs, stepMs);
      if (
        !gridBoundaryBelongsToInterval(
          ageMs,
          startAgeMs,
          endAgeMs,
          includeEnd,
          toleranceMs,
        )
      )
        continue;

      const relativeAgeMs = ageMs - originAgeMs;
      if (relativeAgeMs < -toleranceMs) continue;

      const tickPosition = ghostPositionForAge(
        Math.max(0, relativeAgeMs),
        halfLifeMs,
      );
      if (!(tickPosition >= 0 && tickPosition < 1)) continue;

      const nextPosition = ghostPositionForAge(
        Math.max(0, relativeAgeMs + stepMs),
        halfLifeMs,
      );
      const spacingPx = Math.abs(nextPosition - tickPosition) * widthPx;
      const opacity = legendTickOpacity(
        spacingPx,
        minDistancePx,
        fadeDistancePx,
      );
      // A finer family can place its boundary earlier in this same nonlinear
      // screen interval, where projected spacing is larger, so an invisible
      // coarse candidate does not justify terminating the search.
      if (opacity <= 1 / 255) continue;

      const tick: GhostLegendTick = {
        ageMs: normalizeZero(ageMs),
        position: tickPosition,
        opacity,
        stepMs,
        label: formatDurationTick(ageMs),
      };
      const existing = byAge.get(tick.ageMs);
      if (!existing || tick.opacity > existing.opacity)
        byAge.set(tick.ageMs, tick);
      break;
    }
  }

  return [...byAge.values()].sort((a, b) => a.position - b.position);
}

export function ghostPositionForAge(ageMs: number, halfLifeMs: number): number {
  if (!(ageMs > 0)) return 0;
  if (!(halfLifeMs > 0)) return 1;
  return 1 - 2 ** (-ageMs / halfLifeMs);
}

export function ageAtGhostPosition(
  position: number,
  halfLifeMs: number,
): number {
  const p = Math.max(0, Math.min(1 - Number.EPSILON, position));
  return -halfLifeMs * Math.log2(1 - p);
}

export function formatDurationTick(ageMs: number): string {
  if (Object.is(ageMs, -0) || ageMs === 0) return "now";
  const magnitude = Math.abs(ageMs);
  const sign = ageMs < 0 ? "−" : "";
  if (magnitude < 1) {
    const microseconds = magnitude * 1_000;
    if (microseconds >= 1) return `${sign}${compact(microseconds)}µs`;
    return `${sign}${compact(magnitude * 1_000_000)}ns`;
  }
  if (magnitude < SECOND_MS) return `${sign}${compact(magnitude)}ms`;
  if (magnitude < MINUTE_MS) return `${sign}${compact(magnitude / SECOND_MS)}s`;
  if (magnitude < HOUR_MS) return `${sign}${compact(magnitude / MINUTE_MS)}m`;
  if (magnitude < DAY_MS) return `${sign}${compact(magnitude / HOUR_MS)}h`;
  if (magnitude < MONTH_MS) return `${sign}${compact(magnitude / DAY_MS)}d`;
  if (magnitude < YEAR_MS) return `${sign}${compact(magnitude / MONTH_MS)}mo`;
  return `${sign}${compact(magnitude / YEAR_MS)}y`;
}

function durationSteps(): number[] {
  const values = new Set<number>();

  // Keep the family set stable while the scale moves. Candidate visibility is
  // determined continuously by projected spacing below; adding/removing an
  // entire family based on the current range would make major ticks pop.
  for (let exponent = -12; exponent <= 2; exponent++)
    for (const multiplier of [1, 2, 5])
      addStep(values, multiplier * 10 ** exponent);

  for (const value of [1, 2, 5, 10, 20, 50, 100, 200, 500])
    addStep(values, value);
  for (const value of [1, 2, 5, 10, 15, 30]) addStep(values, value * SECOND_MS);
  for (const value of [1, 2, 5, 10, 15, 30]) addStep(values, value * MINUTE_MS);
  for (const value of [1, 2, 3, 6, 12]) addStep(values, value * HOUR_MS);
  for (const value of [1, 2, 7, 14]) addStep(values, value * DAY_MS);
  for (const value of [1, 2, 3, 6]) addStep(values, value * MONTH_MS);

  for (let exponent = 0; exponent <= 9; exponent++)
    for (const multiplier of [1, 2, 5])
      addStep(values, multiplier * YEAR_MS * 10 ** exponent);

  return [...values].sort((a, b) => b - a);
}

function firstGridBoundaryAtOrAfter(value: number, step: number): number {
  const quotient = value / step;
  const nearest = Math.round(quotient);
  const epsilon = 1e-12 * Math.max(1, Math.abs(quotient));
  const index =
    Math.abs(quotient - nearest) <= epsilon ? nearest : Math.ceil(quotient);
  return index * step;
}

function gridBoundaryBelongsToInterval(
  value: number,
  start: number,
  end: number,
  includeEnd: boolean,
  tolerance: number,
): boolean {
  if (value < start - tolerance || value > end + tolerance) return false;
  if (Math.abs(value - start) <= tolerance) return true;
  if (Math.abs(value - end) <= tolerance) return includeEnd;
  return value > start && value < end;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function compact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(3));
  return rounded.toString();
}

function addStep(target: Set<number>, value: number): void {
  if (value > 0 && Number.isFinite(value)) target.add(value);
}
