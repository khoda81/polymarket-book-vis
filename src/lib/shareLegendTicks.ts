import { legendTickOpacity } from "./legendTickDensity";
import { fmtSIAtExponent } from "./math";

const SHARE_STEP_MULTIPLIERS = [1, 0.5] as const;

export interface ShareLegendTick {
  readonly value: number;
  readonly position: number;
  readonly opacity: number;
  /** Engineering decade chosen by the tick family for display. */
  readonly displayExponent: number;
  readonly label: string;
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
 * We sample tiny screen intervals, find the largest 1/5 × 10^n value grid
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
  const fadeDistancePx = options.fadeDistancePx ?? minDistancePx * 2;
  const edgePaddingPx = options.edgePaddingPx ?? minDistancePx / 2;
  const minPosition = Math.min(0.49, Math.max(0, edgePaddingPx / widthPx));
  const maxPosition = 1 - minPosition;
  const sampleCount = Math.max(64, Math.ceil(widthPx * 4));
  const byValue = new Map<number, ShareLegendTick>();

  const zero: ShareLegendTick = {
    value: 0,
    position: 0.5,
    opacity: 1,
    displayExponent: 0,
    label: "0",
  };
  byValue.set(0, zero);

  let previousValue = shareValueAtPosition(minPosition, reserve);
  for (let index = 1; index <= sampleCount; index++) {
    const position =
      minPosition + (index / sampleCount) * (maxPosition - minPosition);
    const nextValue = shareValueAtPosition(position, reserve);

    if (previousValue < 0 && nextValue >= 0) {
      previousValue = nextValue;
      continue;
    }

    const family = biggestNiceStepCrossing(previousValue, nextValue);
    if (family === null) {
      previousValue = nextValue;
      continue;
    }

    const value = firstGridBoundaryAfter(previousValue, family.step);
    previousValue = nextValue;
    if (
      value === 0 ||
      value < shareValueAtPosition(minPosition, reserve) ||
      value > shareValueAtPosition(maxPosition, reserve)
    )
      continue;

    const tickPosition = shareLegendPosition(value, reserve);
    const nextPosition = shareLegendPosition(value + family.step, reserve);
    const previousPosition = shareLegendPosition(value - family.step, reserve);
    const spacingPx =
      Math.min(
        Math.abs(nextPosition - tickPosition),
        Math.abs(tickPosition - previousPosition),
      ) * widthPx;
    const opacity = legendTickOpacity(spacingPx, minDistancePx, fadeDistancePx);
    if (opacity <= 1 / 255) continue;

    const normalizedValue = normalizeZero(value);
    const displayExponent = engineeringExponent(family.exponent);
    const tick: ShareLegendTick = {
      value: normalizedValue,
      position: tickPosition,
      opacity,
      displayExponent,
      label: formatShareTick(normalizedValue, displayExponent),
    };
    const existing = byValue.get(tick.value);
    if (!existing || tick.opacity > existing.opacity)
      byValue.set(tick.value, tick);
  }

  return [...byValue.values()].sort((a, b) => a.value - b.value);
}

export function shareLegendPosition(value: number, reserve: number): number {
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

  const magnitude = (reserve * Math.abs(signed)) / (1 - Math.abs(signed));
  return Math.sign(signed) * magnitude;
}

interface ShareStepFamily {
  readonly step: number;
  readonly exponent: number;
}

function biggestNiceStepCrossing(
  start: number,
  end: number,
): ShareStepFamily | null {
  if (!(end > start)) return null;

  const maxMagnitude = Math.max(
    Math.abs(start),
    Math.abs(end),
    Number.MIN_VALUE,
  );

  // Start one decade above the data because 0.5 × 10^N is part of the family.
  // Search order follows the family declaration:
  // 1eN, 0.5eN, 1e(N-1), 0.5e(N-1), ...
  let exponent = Math.floor(Math.log10(maxMagnitude)) + 1;
  for (let guard = 0; guard < 700; guard++, exponent--) {
    for (const multiplier of SHARE_STEP_MULTIPLIERS) {
      const step = multiplier * 10 ** exponent;
      if (!(step > 0) || !Number.isFinite(step)) continue;
      if (firstGridBoundaryAfter(start, step) <= end) return { step, exponent };
    }
  }
  return null;
}

function firstGridBoundaryAfter(value: number, step: number): number {
  const quotient = value / step;
  const nearest = Math.round(quotient);
  const epsilon = 1e-12 * Math.max(1, Math.abs(quotient));
  const index =
    Math.abs(quotient - nearest) <= epsilon ? nearest + 1 : Math.ceil(quotient);
  return index * step;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function engineeringExponent(exponent: number): number {
  return Math.floor(exponent / 3) * 3;
}

function formatShareTick(value: number, displayExponent: number): string {
  if (value === 0) return "0";
  const magnitude = fmtSIAtExponent(Math.abs(value), displayExponent);
  return `${value > 0 ? "+" : "−"}${magnitude}`;
}
