import { fmtRelativeTimeOffset } from "@/shared/math";
import { tickDensityOpacity } from "../ticks/density";
import { placeQuantileTicks } from "../ticks/quantileTicks";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export interface GhostLegendTick {
  readonly ageMs: number;
  readonly position: number;
  readonly opacity: number;
  /** Human grid family that produced this tick; larger means coarser. */
  readonly stepMs: number;
  readonly label: string;
}

export interface GhostLegendTickOptions {
  /** Required presentation policy from the caller, in CSS pixels. */
  readonly minSpacingPx: number;
  readonly fullOpacitySpacingPx: number;
  /**
   * Local-clock offset at the left edge of the scale. Positive is in the past;
   * negative means the newest observation timestamp is ahead of local time.
   */
  readonly originAgeMs: number;
  /** Physical pixels per CSS pixel. */
  readonly dpr: number;
}

/**
 * QBar-style ticks for the exponential ghost-age transform:
 *
 *   x(Δt) = 1 - 2^(-Δt / halfLife)
 *
 * Placement itself knows nothing about this transform's inverse. We provide
 * only its quantile function to the generic raster tick placer, which searches
 * half-open screen ranges, locates the owning physical pixel, and estimates
 * density from the value interval represented by that pixel.
 */
export function ghostLegendTicks(
  halfLifeMs: number,
  widthPx: number,
  options: GhostLegendTickOptions,
): readonly GhostLegendTick[] {
  const pixelCount = Math.round(widthPx * options.dpr);
  const minSpacingRasterPx = Math.round(options.minSpacingPx * options.dpr);

  const placements = placeQuantileTicks({
    pixelCount,
    minSpacingPx: minSpacingRasterPx,
    quantile: (position) =>
      options.originAgeMs + ageAtGhostPosition(position, halfLifeMs),
    refinementSteps: durationRefinementSteps(),
  });

  return placements
    .map((placement): GhostLegendTick => {
      const opacity = tickDensityOpacity(
        placement.densityPx / options.dpr,
        options.minSpacingPx,
        options.fullOpacitySpacingPx,
      );
      return {
        ageMs: placement.value,
        position: placement.position,
        opacity,
        stepMs: placement.step,
        label: fmtRelativeTimeOffset(placement.value / SECOND_MS),
      };
    })
    .filter((tick) => tick.opacity > 1 / 255);
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
  return -halfLifeMs * Math.log2(1 - position);
}

const DURATION_REFINEMENT_STEPS = buildDurationRefinementSteps();

export function durationRefinementSteps(): readonly number[] {
  return DURATION_REFINEMENT_STEPS;
}

function buildDurationRefinementSteps(): readonly number[] {
  const steps: number[] = [];

  // Decimal coarse scales use the nested 1 / 0.5 pattern, but only for exact
  // interval units: ... 100w, 50w, 10w, 5w, 1w.
  for (let exponent = 9; exponent >= 1; exponent--) {
    steps.push(WEEK_MS * 10 ** exponent);
    steps.push(0.5 * WEEK_MS * 10 ** exponent);
  }

  // Human-unit bridges. Every next step divides the previous one exactly, so
  // every coarse grid is a literal subset of every finer grid.
  steps.push(
    WEEK_MS,
    DAY_MS,
    12 * HOUR_MS,
    6 * HOUR_MS,
    3 * HOUR_MS,
    HOUR_MS,
    30 * MINUTE_MS,
    10 * MINUTE_MS,
    5 * MINUTE_MS,
    MINUTE_MS,
    30 * SECOND_MS,
    10 * SECOND_MS,
    5 * SECOND_MS,
    SECOND_MS,
  );

  // Below one second, continue the same nested 1 / 0.5 decade pattern:
  // 1s, 500ms, 100ms, 50ms, 10ms, 5ms, 1ms, ...
  steps.push(0.5 * SECOND_MS);
  for (let exponent = -1; exponent >= -15; exponent--) {
    steps.push(SECOND_MS * 10 ** exponent);
    steps.push(0.5 * SECOND_MS * 10 ** exponent);
  }

  return steps;
}
