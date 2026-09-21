import { expect, test } from "bun:test";
import {
  selectShareLegendLabels,
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

  const labels = selectShareLegendLabels(ticks, 720, 48);
  for (let index = 1; index < labels.length; index++)
    expect(
      (labels[index]!.position - labels[index - 1]!.position) * 720,
    ).toBeGreaterThanOrEqual(48);
});

test("realistic compact share legend keeps useful non-zero labels", () => {
  const ticks = shareLegendTicks(11_600, 720, {
    minDistancePx: 16,
  });
  const labels = selectShareLegendLabels(ticks, 720, 48);

  expect(labels.some((tick) => tick.value < 0)).toBe(true);
  expect(labels.some((tick) => tick.value > 0)).toBe(true);
  expect(labels.some((tick) => tick.value === 0)).toBe(true);
});

test("realistic reserve produces visibly opaque share tick families", () => {
  const ticks = shareLegendTicks(11_600, 430, {
    minDistancePx: 16,
  });

  expect(ticks.some((tick) => tick.value !== 0 && tick.opacity >= 0.5)).toBe(
    true,
  );
});
