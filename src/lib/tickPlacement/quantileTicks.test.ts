import { expect, test } from "bun:test";
import { placeQuantileTicks } from "./quantileTicks";

test("exact shared boundaries belong to the bucket and pixel on their right", () => {
  const ticks = placeQuantileTicks({
    pixelCount: 8,
    minSpacingPx: 4,
    quantile: (position) => position * 8,
    refinementSteps: [4, 2, 1],
  });

  expect(ticks).toEqual([
    {
      value: 0,
      step: 4,
      pixel: 0,
      position: 0.0625,
      densityPx: 4,
    },
    {
      value: 4,
      step: 4,
      pixel: 4,
      position: 0.5625,
      densityPx: 4,
    },
  ]);
});

test("binary search locates the pixel whose value range covers the tick", () => {
  const ticks = placeQuantileTicks({
    pixelCount: 16,
    minSpacingPx: 8,
    quantile: (position) => position * position * 16,
    refinementSteps: [4, 2, 1],
  });

  const four = ticks.find((tick) => tick.value === 4);
  expect(four).toBeDefined();
  expect(four!.pixel).toBe(8);

  const left = (four!.pixel / 16) ** 2 * 16;
  const right = ((four!.pixel + 1) / 16) ** 2 * 16;
  expect(four!.value).toBeGreaterThanOrEqual(left);
  expect(four!.value).toBeLessThan(right);
  expect(four!.densityPx).toBeCloseTo(four!.step / (right - left));
});

test("the final half-open bucket may end at an infinite quantile", () => {
  const ticks = placeQuantileTicks({
    pixelCount: 10,
    minSpacingPx: 6,
    quantile: (position) =>
      position === 1 ? Number.POSITIVE_INFINITY : position * 10,
    refinementSteps: [5, 2, 1],
  });

  expect(ticks.map((tick) => tick.value)).toEqual([0, 10]);
  expect(ticks.at(-1)!.pixel).toBe(9);
  expect(ticks.at(-1)!.densityPx).toBe(0);
});

test("one quantile evaluation per search boundary plus logarithmic pixel search", () => {
  let calls = 0;
  placeQuantileTicks({
    pixelCount: 64,
    minSpacingPx: 16,
    quantile: (position) => {
      calls++;
      return position * 64;
    },
    refinementSteps: [16, 8, 4, 2, 1],
  });

  expect(calls).toBeLessThan(40);
});
