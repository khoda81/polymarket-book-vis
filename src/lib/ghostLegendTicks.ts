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
 * relative-to-newest coordinates. Human grid boundaries are enumerated
 * directly and projected through the inverse/forward transform; each family's
 * projected spacing continuously controls its opacity. As the newest
 * observation moves relative to the local clock, labels and positions move
 * together without changing candidate families discontinuously.
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
  const maxPosition = Math.max(
    0,
    Math.min(1 - Number.EPSILON, 1 - 0.5 / widthPx),
  );
  const maxAgeMs = originAgeMs + ageAtGhostPosition(maxPosition, halfLifeMs);
  const steps = durationSteps();
  const byAge = new Map<number, GhostLegendTick>();
  const toleranceMs = Math.max(
    1e-9,
    Math.max(Math.abs(originAgeMs), Math.abs(maxAgeMs)) * 1e-12,
  );

  // Enumerate the actual human-grid boundaries directly. The old implementation
  // sampled screen intervals and selected only the largest family crossed by
  // each sample. As the scale drifted, a tiny change could make a different
  // family "win" that interval and make a fully opaque label pop in/out.
  //
  // For one fixed step family, projected spacing decreases monotonically as we
  // move right, so once its density opacity falls below one alpha step there
  // cannot be another visible tick from that family.
  for (const stepMs of steps) {
    // Projected spacing is maximal at the left edge and only decreases as we
    // move right. Steps are sorted coarse -> fine, so once a family is already
    // below one visible alpha step here, this family and every finer one can be
    // skipped entirely. Besides being cheaper, this prevents asking IEEE-754
    // to enumerate grid steps far smaller than the representable spacing near
    // a large clock offset.
    const maxSpacingPx = ghostPositionForAge(stepMs, halfLifeMs) * widthPx;
    if (
      legendTickOpacity(maxSpacingPx, minDistancePx, fadeDistancePx) <=
      1 / 255
    )
      break;

    let ageMs = firstGridBoundaryAfter(originAgeMs, stepMs);
    while (ageMs <= maxAgeMs + toleranceMs) {
      const relativeAgeMs = ageMs - originAgeMs;
      if (relativeAgeMs <= 0) {
        const nextAgeMs = ageMs + stepMs;
        if (!(nextAgeMs > ageMs)) break;
        ageMs = nextAgeMs;
        continue;
      }

      const tickPosition = ghostPositionForAge(relativeAgeMs, halfLifeMs);
      const nextPosition = ghostPositionForAge(
        relativeAgeMs + stepMs,
        halfLifeMs,
      );
      const spacingPx = Math.abs(nextPosition - tickPosition) * widthPx;
      const opacity = legendTickOpacity(
        spacingPx,
        minDistancePx,
        fadeDistancePx,
      );
      if (opacity <= 1 / 255) break;

      const tick: GhostLegendTick = {
        ageMs,
        position: tickPosition,
        opacity,
        label: formatDurationTick(ageMs),
      };
      const existing = byAge.get(ageMs);
      if (!existing || tick.opacity > existing.opacity) byAge.set(ageMs, tick);

      const nextAgeMs = ageMs + stepMs;
      if (!(nextAgeMs > ageMs)) break;
      ageMs = nextAgeMs;
    }
  }

  return [...byAge.values()].sort((a, b) => a.ageMs - b.ageMs);
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

function firstGridBoundaryAfter(value: number, step: number): number {
  const quotient = value / step;
  const nearest = Math.round(quotient);
  const epsilon = 1e-12 * Math.max(1, Math.abs(quotient));
  const index =
    Math.abs(quotient - nearest) <= epsilon ? nearest + 1 : Math.ceil(quotient);
  return index * step;
}

function compact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(3));
  return rounded.toString();
}

function addStep(target: Set<number>, value: number): void {
  if (value > 0 && Number.isFinite(value)) target.add(value);
}
