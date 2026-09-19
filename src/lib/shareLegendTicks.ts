export interface ShareLegendTick {
  readonly value: number;
  readonly position: number;
  readonly opacity: number;
}

export interface ShareLegendTickOptions {
  readonly minDistancePx?: number;
  readonly fadeDistancePx?: number;
  readonly edgePaddingPx?: number;
}

/**
 * QBar-style ticks for the signed share-pressure transform:
 *
 *   s = q / (|q| + reserve)
 *   x = 1/2 + s/2
 *
 * We sample tiny screen intervals, find the largest 1/2/5 × 10^n value grid
 * that crosses each interval, and fade that grid according to the projected
 * pixel spacing to the next tick from the same family.
 */
export function shareLegendTicks(
  reserve: number,
  widthPx: number,
  options: ShareLegendTickOptions = {},
): ShareLegendTick[] {
  if (!(reserve > 0) || !Number.isFinite(reserve)) return [];
  if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [];

  const minDistancePx = options.minDistancePx ?? 48;
  const fadeDistancePx =
    options.fadeDistancePx ?? minDistancePx * 2;
  const edgePaddingPx =
    options.edgePaddingPx ?? minDistancePx / 2;
  const minPosition = Math.min(
    0.49,
    Math.max(0, edgePaddingPx / widthPx),
  );
  const maxPosition = 1 - minPosition;
  const sampleCount = Math.max(64, Math.ceil(widthPx * 4));
  const byValue = new Map<number, ShareLegendTick>();

  const zero: ShareLegendTick = {
    value: 0,
    position: 0.5,
    opacity: 1,
  };
  byValue.set(0, zero);

  let previousValue = shareValueAtPosition(
    minPosition,
    reserve,
  );
  for (let index = 1; index <= sampleCount; index++) {
    const position =
      minPosition +
      (index / sampleCount) *
        (maxPosition - minPosition);
    const nextValue = shareValueAtPosition(position, reserve);

    if (previousValue < 0 && nextValue >= 0) {
      previousValue = nextValue;
      continue;
    }

    const step = biggestNiceStepCrossing(
      previousValue,
      nextValue,
    );
    if (step === null) {
      previousValue = nextValue;
      continue;
    }

    const value = firstGridBoundaryAfter(
      previousValue,
      step,
    );
    previousValue = nextValue;
    if (
      value === 0 ||
      value < shareValueAtPosition(minPosition, reserve) ||
      value > shareValueAtPosition(maxPosition, reserve)
    )
      continue;

    const tickPosition = shareLegendPosition(value, reserve);
    const nextPosition = shareLegendPosition(
      value + step,
      reserve,
    );
    const previousPosition = shareLegendPosition(
      value - step,
      reserve,
    );
    const spacingPx =
      Math.min(
        Math.abs(nextPosition - tickPosition),
        Math.abs(tickPosition - previousPosition),
      ) * widthPx;
    const opacity = smoothstep(
      minDistancePx,
      fadeDistancePx,
      spacingPx,
    );
    if (opacity <= 1 / 255) continue;

    const tick: ShareLegendTick = {
      value: normalizeZero(value),
      position: tickPosition,
      opacity,
    };
    const existing = byValue.get(tick.value);
    if (!existing || tick.opacity > existing.opacity)
      byValue.set(tick.value, tick);
  }

  return [...byValue.values()].sort((a, b) => a.value - b.value);
}

export function selectShareLegendLabels(
  ticks: readonly ShareLegendTick[],
  widthPx: number,
  minDistancePx: number,
  minOpacity = 0.55,
): ShareLegendTick[] {
  if (!(widthPx > 0) || !(minDistancePx > 0)) return [];

  const selected: ShareLegendTick[] = [];
  for (const tick of [...ticks]
    .filter((candidate) => candidate.opacity >= minOpacity)
    .sort(
      (a, b) =>
        b.opacity - a.opacity ||
        Math.abs(b.value) - Math.abs(a.value),
    )) {
    const x = tick.position * widthPx;
    if (
      selected.every(
        (other) =>
          Math.abs(x - other.position * widthPx) >=
          minDistancePx,
      )
    )
      selected.push(tick);
  }

  return selected.sort((a, b) => a.value - b.value);
}

export function shareLegendPosition(
  value: number,
  reserve: number,
): number {
  if (!(reserve > 0) || !Number.isFinite(reserve)) return 0.5;
  if (Number.isNaN(value) || value === 0) return 0.5;

  const signed = Number.isFinite(value)
    ? value / (Math.abs(value) + reserve)
    : Math.sign(value);
  return 0.5 + 0.5 * signed;
}

export function shareValueAtPosition(
  position: number,
  reserve: number,
): number {
  const signed = Math.max(
    -1 + Number.EPSILON,
    Math.min(1 - Number.EPSILON, 2 * position - 1),
  );
  if (signed === 0) return 0;

  const magnitude =
    (reserve * Math.abs(signed)) /
    (1 - Math.abs(signed));
  return Math.sign(signed) * magnitude;
}

function biggestNiceStepCrossing(
  start: number,
  end: number,
): number | null {
  if (!(end > start)) return null;

  const maxMagnitude = Math.max(
    Math.abs(start),
    Math.abs(end),
    Number.MIN_VALUE,
  );
  let exponent = Math.floor(Math.log10(maxMagnitude));

  // Descending sequence across decades:
  // 5eN, 2eN, 1eN, 5e(N-1), ...
  for (let guard = 0; guard < 700; guard++, exponent--) {
    for (const multiplier of [5, 2, 1]) {
      const step = multiplier * 10 ** exponent;
      if (!(step > 0) || !Number.isFinite(step)) continue;
      if (firstGridBoundaryAfter(start, step) <= end)
        return step;
    }
  }
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

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
