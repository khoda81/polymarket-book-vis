import { expect, test } from "bun:test";
import {
  buildFrontier,
  frontierLevel,
  frontierLevels,
  frontierVolumeAt,
  setFrontierLevel,
} from "./monotoneFrontier";
import { priceFromLegacyNumber as p, type Price } from "./price";

test("frontier is monotone by construction", () => {
  const root = buildFrontier([
    { key: p(0.2), weight: 10 },
    { key: p(0.5), weight: 20 },
    { key: p(0.8), weight: 30 },
  ]);

  expect(frontierVolumeAt(root, p(0))).toBe(60);
  expect(frontierVolumeAt(root, p(0.2))).toBe(60);
  expect(frontierVolumeAt(root, p(0.3))).toBe(50);
  expect(frontierVolumeAt(root, p(0.5))).toBe(50);
  expect(frontierVolumeAt(root, p(0.7))).toBe(30);
  expect(frontierVolumeAt(root, p(0.9))).toBe(0);

  const samples = Array.from({ length: 101 }, (_, index) =>
    frontierVolumeAt(root, p(index / 100)),
  );
  for (let index = 1; index < samples.length; index++)
    expect(samples[index]!).toBeLessThanOrEqual(samples[index - 1]!);
});

test("persistent updates share the untouched frontier", () => {
  const first = buildFrontier([
    { key: p(0.2), weight: 10 },
    { key: p(0.5), weight: 20 },
    { key: p(0.8), weight: 30 },
  ]);
  const second = setFrontierLevel(first, p(0.5), 7);

  expect(frontierVolumeAt(first, p(0.5))).toBe(50);
  expect(frontierVolumeAt(second, p(0.5))).toBe(37);
  expect(frontierVolumeAt(first, p(0.7))).toBe(30);
  expect(frontierVolumeAt(second, p(0.7))).toBe(30);
  expect(frontierLevel(first, p(0.5))).toBe(20);
  expect(frontierLevel(second, p(0.5))).toBe(7);
});

test("zero weight removes a level without changing other levels", () => {
  const first = buildFrontier([
    { key: p(0.25), weight: 8 },
    { key: p(0.75), weight: 12 },
  ]);
  const second = setFrontierLevel(first, p(0.25), 0);

  expect(frontierLevels(second)).toEqual([{ key: p(0.75), weight: 12 }]);
  expect(frontierVolumeAt(second, p(0))).toBe(12);
  expect(frontierVolumeAt(second, p(0.8))).toBe(0);
});

test("invalid atoms cannot enter the frontier", () => {
  expect(() => setFrontierLevel(null, -1 as Price, 1)).toThrow();
  expect(() => setFrontierLevel(null, p(0.5), -1)).toThrow();
  expect(() =>
    setFrontierLevel(null, p(0.5), Number.POSITIVE_INFINITY),
  ).toThrow();
});
