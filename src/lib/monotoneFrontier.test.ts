import { expect, test } from "bun:test";
import {
  buildFrontier,
  frontierLevel,
  frontierLevels,
  frontierVolumeAt,
  setFrontierLevel,
} from "./monotoneFrontier";

test("frontier is monotone by construction", () => {
  const root = buildFrontier([
    { key: 0.2, weight: 10 },
    { key: 0.5, weight: 20 },
    { key: 0.8, weight: 30 },
  ]);

  expect(frontierVolumeAt(root, 0)).toBe(60);
  expect(frontierVolumeAt(root, 0.2)).toBe(60);
  expect(frontierVolumeAt(root, 0.3)).toBe(50);
  expect(frontierVolumeAt(root, 0.5)).toBe(50);
  expect(frontierVolumeAt(root, 0.7)).toBe(30);
  expect(frontierVolumeAt(root, 0.9)).toBe(0);

  const samples = Array.from(
    { length: 101 },
    (_, index) => frontierVolumeAt(root, index / 100),
  );
  for (let index = 1; index < samples.length; index++)
    expect(samples[index]!).toBeLessThanOrEqual(samples[index - 1]!);
});

test("persistent updates share the untouched frontier", () => {
  const first = buildFrontier([
    { key: 0.2, weight: 10 },
    { key: 0.5, weight: 20 },
    { key: 0.8, weight: 30 },
  ]);
  const second = setFrontierLevel(first, 0.5, 7);

  expect(frontierVolumeAt(first, 0.5)).toBe(50);
  expect(frontierVolumeAt(second, 0.5)).toBe(37);
  expect(frontierVolumeAt(first, 0.7)).toBe(30);
  expect(frontierVolumeAt(second, 0.7)).toBe(30);
  expect(frontierLevel(first, 0.5)).toBe(20);
  expect(frontierLevel(second, 0.5)).toBe(7);
});

test("zero weight removes a level without changing other levels", () => {
  const first = buildFrontier([
    { key: 0.25, weight: 8 },
    { key: 0.75, weight: 12 },
  ]);
  const second = setFrontierLevel(first, 0.25, 0);

  expect(frontierLevels(second)).toEqual([{ key: 0.75, weight: 12 }]);
  expect(frontierVolumeAt(second, 0)).toBe(12);
  expect(frontierVolumeAt(second, 0.8)).toBe(0);
});

test("invalid atoms cannot enter the frontier", () => {
  expect(() => setFrontierLevel(null, -0.1, 1)).toThrow();
  expect(() => setFrontierLevel(null, 0.5, -1)).toThrow();
  expect(() =>
    setFrontierLevel(null, 0.5, Number.POSITIVE_INFINITY),
  ).toThrow();
});
