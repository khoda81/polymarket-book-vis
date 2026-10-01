import { expect, test } from "bun:test";
import {
  shareLegendPosition,
  shareLegendTicks,
  shareRefinementSteps,
  shareValueAtPosition,
} from "./shareLegendTicks";

const DEFAULT_OPTIONS = {
  minSpacingPx: 16,
  fullOpacitySpacingPx: 32,
  dpr: 1,
} as const;

test("share pressure transform is invertible away from asymptotic edges", () => {
  const reserve = 1_500;
  for (const value of [-1e6, -1000, -1, 0, 1, 1000, 1e6]) {
    const p = shareLegendPosition(value, reserve);
    expect(shareValueAtPosition(p, reserve)).toBeCloseTo(value, 6);
  }
  expect(shareValueAtPosition(0, reserve)).toBe(Number.NEGATIVE_INFINITY);
  expect(shareValueAtPosition(1, reserve)).toBe(Number.POSITIVE_INFINITY);
});

test("share refinement steps form one recursive subset lattice", () => {
  const steps = shareRefinementSteps(2e6, 10);
  for (let index = 0; index + 1 < steps.length; index++) {
    const ratio = steps[index]! / steps[index + 1]!;
    expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-12);
  }
});

test("share ticks are symmetric, adaptive, and fade by local density", () => {
  const ticks = shareLegendTicks(1_500, 720, DEFAULT_OPTIONS);
  expect(ticks.some((tick) => tick.value === 0)).toBe(true);
  expect(ticks.some((tick) => tick.value < 0)).toBe(true);
  expect(ticks.some((tick) => tick.value > 0)).toBe(true);
  expect(ticks.some((tick) => tick.opacity < 1)).toBe(true);
});

test("compact mobile share legend still has non-zero ticks", () => {
  const ticks = shareLegendTicks(11_600, 220, DEFAULT_OPTIONS);
  expect(ticks.some((tick) => tick.value < 0)).toBe(true);
  expect(ticks.some((tick) => tick.value > 0)).toBe(true);
  expect(ticks.some((tick) => tick.value === 0)).toBe(true);
});

test("realistic reserve produces visibly opaque share tick families", () => {
  const ticks = shareLegendTicks(11_600, 430, DEFAULT_OPTIONS);
  expect(ticks.some((tick) => tick.value !== 0 && tick.opacity >= 0.5)).toBe(
    true,
  );
});

test("compact signed legend fades dense tick families progressively", () => {
  const ticks = shareLegendTicks(11_600, 430, {
    ...DEFAULT_OPTIONS,
    minSpacingPx: 20,
    fullOpacitySpacingPx: 40,
  });
  const nonZero = ticks.filter((tick) => tick.value !== 0);
  const opacities = nonZero.map((tick) => tick.opacity);
  const minOpacity = Math.min(...opacities);
  const maxOpacity = Math.max(...opacities);

  expect(nonZero.length).toBeGreaterThan(0);
  expect(minOpacity).toBeGreaterThan(0);
  expect(maxOpacity - minOpacity).toBeGreaterThan(0.05);
  expect(maxOpacity).toBeLessThanOrEqual(1);
});
