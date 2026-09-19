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
}

/**
 * QBar-style ticks for the exponential ghost-age transform:
 *
 *   x(t) = 1 - 2^(-t / halfLife)
 *
 * For each tiny screen interval, choose the largest human-friendly duration
 * grid whose boundary crosses that interval. Opacity then depends on the local
 * pixel spacing to the next tick from the same family, so dense families fade
 * continuously instead of popping on/off.
 */
export function ghostLegendTicks(
  halfLifeMs: number,
  widthPx: number,
  options: GhostLegendTickOptions = {},
): GhostLegendTick[] {
  if (!(halfLifeMs > 0) || !Number.isFinite(halfLifeMs)) return [];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [];

  const minDistancePx = options.minDistancePx ?? 48;
  const fadeDistancePx =
    options.fadeDistancePx ?? minDistancePx * 2;
  const sampleCount = Math.max(64, Math.ceil(widthPx * 4));
  const maxPosition = Math.max(
    0,
    Math.min(1 - Number.EPSILON, 1 - 0.5 / widthPx),
  );
  const maxAgeMs = ageAtGhostPosition(maxPosition, halfLifeMs);
  const steps = durationSteps(maxAgeMs);
  const byAge = new Map<number, GhostLegendTick>();

  let previousAgeMs = 0;
  for (let index = 1; index <= sampleCount; index++) {
    const position = (index / sampleCount) * maxPosition;
    const nextAgeMs = ageAtGhostPosition(position, halfLifeMs);
    const stepMs = biggestCrossedStep(
      previousAgeMs,
      nextAgeMs,
      steps,
    );
    previousAgeMs = nextAgeMs;
    if (stepMs === null) continue;

    const ageMs = firstGridBoundaryAfter(
      ageAtGhostPosition(
        ((index - 1) / sampleCount) * maxPosition,
        halfLifeMs,
      ),
      stepMs,
    );
    if (!(ageMs > 0) || ageMs > nextAgeMs * (1 + 1e-12))
      continue;

    const tickPosition = ghostPositionForAge(ageMs, halfLifeMs);
    const nextPosition = ghostPositionForAge(
      ageMs + stepMs,
      halfLifeMs,
    );
    const spacingPx = Math.abs(nextPosition - tickPosition) * widthPx;
    const opacity = smoothstep(
      minDistancePx,
      fadeDistancePx,
      spacingPx,
    );
    if (opacity <= 1 / 255) continue;

    const tick: GhostLegendTick = {
      ageMs,
      position: tickPosition,
      opacity,
      label: formatDurationTick(ageMs),
    };
    const existing = byAge.get(ageMs);
    if (!existing || tick.opacity > existing.opacity)
      byAge.set(ageMs, tick);
  }

  return [...byAge.values()].sort((a, b) => a.ageMs - b.ageMs);
}

export function ghostPositionForAge(
  ageMs: number,
  halfLifeMs: number,
): number {
  if (!(ageMs > 0)) return 0;
  if (!(halfLifeMs > 0)) return 1;
  return 1 - 2 ** (-ageMs / halfLifeMs);
}

export function ageAtGhostPosition(
  position: number,
  halfLifeMs: number,
): number {
  const p = Math.max(
    0,
    Math.min(1 - Number.EPSILON, position),
  );
  return -halfLifeMs * Math.log2(1 - p);
}

export function formatDurationTick(ageMs: number): string {
  const magnitude = Math.abs(ageMs);
  if (magnitude < 1) {
    const microseconds = ageMs * 1_000;
    if (Math.abs(microseconds) >= 1)
      return `${compact(microseconds)}µs`;
    return `${compact(ageMs * 1_000_000)}ns`;
  }
  if (magnitude < SECOND_MS)
    return `${compact(ageMs)}ms`;
  if (magnitude < MINUTE_MS)
    return `${compact(ageMs / SECOND_MS)}s`;
  if (magnitude < HOUR_MS)
    return `${compact(ageMs / MINUTE_MS)}m`;
  if (magnitude < DAY_MS)
    return `${compact(ageMs / HOUR_MS)}h`;
  if (magnitude < MONTH_MS)
    return `${compact(ageMs / DAY_MS)}d`;
  if (magnitude < YEAR_MS)
    return `${compact(ageMs / MONTH_MS)}mo`;
  return `${compact(ageMs / YEAR_MS)}y`;
}

function durationSteps(maxAgeMs: number): number[] {
  const values = new Set<number>();

  // Decimal sub-second families remain useful when the half-life is tiny.
  const maxSubSecondExponent = Math.min(
    2,
    Math.ceil(Math.log10(Math.max(maxAgeMs, 1e-12))),
  );
  for (
    let exponent = maxSubSecondExponent - 12;
    exponent <= maxSubSecondExponent;
    exponent++
  )
    for (const multiplier of [1, 2, 5])
      addStep(values, multiplier * 10 ** exponent);

  for (const value of [1, 2, 5, 10, 20, 50, 100, 200, 500])
    addStep(values, value);
  for (const value of [1, 2, 5, 10, 15, 30])
    addStep(values, value * SECOND_MS);
  for (const value of [1, 2, 5, 10, 15, 30])
    addStep(values, value * MINUTE_MS);
  for (const value of [1, 2, 3, 6, 12])
    addStep(values, value * HOUR_MS);
  for (const value of [1, 2, 7, 14])
    addStep(values, value * DAY_MS);
  for (const value of [1, 2, 3, 6])
    addStep(values, value * MONTH_MS);

  const yearExponent = Math.floor(
    Math.log10(Math.max(maxAgeMs / YEAR_MS, 1e-12)),
  );
  for (
    let exponent = Math.min(-1, yearExponent - 2);
    exponent <= yearExponent + 2;
    exponent++
  )
    for (const multiplier of [1, 2, 5]) {
      const step = multiplier * YEAR_MS * 10 ** exponent;
      if (step >= 6 * MONTH_MS) addStep(values, step);
    }

  return [...values]
    .filter(
      (value) =>
        value > 0 &&
        Number.isFinite(value) &&
        value <= maxAgeMs * 2,
    )
    .sort((a, b) => b - a);
}

function biggestCrossedStep(
  startMs: number,
  endMs: number,
  steps: readonly number[],
): number | null {
  if (!(endMs > startMs)) return null;
  for (const stepMs of steps)
    if (firstGridBoundaryAfter(startMs, stepMs) <= endMs)
      return stepMs;
  return null;
}

function firstGridBoundaryAfter(
  value: number,
  step: number,
): number {
  const quotient = value / step;
  const nearest = Math.round(quotient);
  const epsilon = 1e-12 * Math.max(1, Math.abs(quotient));
  const index =
    Math.abs(quotient - nearest) <= epsilon
      ? nearest + 1
      : Math.ceil(quotient);
  return index * step;
}

function smoothstep(
  edge0: number,
  edge1: number,
  value: number,
): number {
  if (edge1 <= edge0) return value <= edge0 ? 0 : 1;
  const x = Math.max(
    0,
    Math.min(1, (value - edge0) / (edge1 - edge0)),
  );
  return x * x * (3 - 2 * x);
}

function compact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const rounded = Number(value.toPrecision(3));
  return rounded.toString();
}

function addStep(target: Set<number>, value: number): void {
  if (value > 0 && Number.isFinite(value)) target.add(value);
}
