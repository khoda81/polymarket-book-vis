import { expect, test } from "bun:test";
import {
  shareLegendPosition,
  shareLegendTicks,
  shareValueAtPosition,
} from "./shareLegendTicks";

test("share pressure transform is invertible away from asymptotic edges", () => {
  const reserve = 1_500;
  for (const value of [-1e6, -1000, -1, 0, 1, 1000, 1e6]) {
    const p = shareLegendPosition(value, reserve);
    expect(shareValueAtPosition(p, reserve)).toBeCloseTo(value, 6);
  }
});

test("share ticks are symmetric, adaptive, and fade by family spacing", () => {
  const ticks = shareLegendTicks(1_500, 720);
  expect(ticks.some((tick) => tick.value === 0)).toBe(true);
  expect(ticks.some((tick) => tick.value < 0)).toBe(true);
  expect(ticks.some((tick) => tick.value > 0)).toBe(true);
  expect(ticks.some((tick) => tick.opacity < 1)).toBe(true);
});

test("realistic compact share legend keeps useful non-zero ticks", () => {
  const ticks = shareLegendTicks(11_600, 720, {
    minDistancePx: 16,
  });

  expect(ticks.some((tick) => tick.value < 0)).toBe(true);
  expect(ticks.some((tick) => tick.value > 0)).toBe(true);
  expect(ticks.some((tick) => tick.value === 0)).toBe(true);
});

test("realistic reserve produces visibly opaque share tick families", () => {
  const ticks = shareLegendTicks(11_600, 430, {
    minDistancePx: 16,
  });

  expect(ticks.some((tick) => tick.value !== 0 && tick.opacity >= 0.5)).toBe(
    true,
  );
});

test("compact signed legend fades dense tick families progressively", () => {
  const ticks = shareLegendTicks(11_600, 430, {
    minDistancePx: 20,
  });
  const nonZero = ticks.filter((tick) => tick.value !== 0);
  const opacities = nonZero.map((tick) => tick.opacity);
  const minOpacity = Math.min(...opacities);
  const maxOpacity = Math.max(...opacities);

  expect(nonZero.length).toBeGreaterThan(0);
  expect(minOpacity).toBeGreaterThan(0);
  expect(maxOpacity - minOpacity).toBeGreaterThan(0.05);
  expect(maxOpacity).toBeLessThan(1);
});
