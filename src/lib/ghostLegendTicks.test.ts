import { expect, test } from "bun:test";
import {
  ageAtGhostPosition,
  formatDurationTick,
  ghostLegendTicks,
  ghostPositionForAge,
} from "./ghostLegendTicks";

test("ghost age transform is invertible", () => {
  for (const age of [1, 10, 1_000, 60_000, 100_000]) {
    const p = ghostPositionForAge(age, 5_000);
    expect(ageAtGhostPosition(p, 5_000)).toBeCloseTo(age);
  }
});

test("duration ticks use human unit families and fade by local spacing", () => {
  const ticks = ghostLegendTicks(60 * 60 * 1_000, 430);
  expect(ticks.length).toBeGreaterThan(2);
  expect(ticks.some((tick) => /h$/.test(tick.label))).toBe(true);
  expect(
    ticks.every(
      (tick) =>
        tick.position > 0 &&
        tick.position < 1 &&
        tick.opacity > 0 &&
        tick.opacity <= 1,
    ),
  ).toBe(true);
  expect(ticks.some((tick) => tick.opacity < 1)).toBe(true);
});

test("duration labels remain readable below milliseconds and above months", () => {
  expect(formatDurationTick(0)).toBe("now");
  expect(formatDurationTick(-50)).toBe("−50ms");
  expect(formatDurationTick(0.1)).toBe("100µs");
  expect(formatDurationTick(1_000)).toBe("1s");
  expect(formatDurationTick(60 * 60 * 1_000)).toBe("1h");
  expect(formatDurationTick(365 * 24 * 60 * 60 * 1_000)).toBe("1y");
});

test("absolute-age ticks are reprojected when the newest observation gets older", () => {
  const fresh = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: 0,
  });
  const stale = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: 1_000,
  });

  const sharedAge = fresh
    .map((tick) => tick.ageMs)
    .find((age) => stale.some((tick) => tick.ageMs === age));
  expect(sharedAge).toBeDefined();

  const freshTick = fresh.find((tick) => tick.ageMs === sharedAge)!;
  const staleTick = stale.find((tick) => tick.ageMs === sharedAge)!;
  expect(staleTick.position).toBeLessThan(freshTick.position);
  expect(staleTick.position).toBeCloseTo(
    ghostPositionForAge(sharedAge! - 1_000, 5_000),
  );
  expect(staleTick.label).toBe(formatDurationTick(sharedAge!));
});

test("signed clock offsets put now at its exact transformed position", () => {
  const ticks = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: -50,
  });
  const now = ticks.find((tick) => tick.ageMs === 0);
  expect(now).toBeDefined();
  expect(now!.label).toBe("now");
  expect(now!.position).toBeCloseTo(ghostPositionForAge(50, 5_000));
});

test("future clock offsets can expose negative tick values", () => {
  const ticks = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: -1_500,
  });
  expect(ticks.some((tick) => tick.ageMs < 0)).toBe(true);
  expect(ticks.some((tick) => tick.label.startsWith("−"))).toBe(true);
});

test("large clock offsets cannot stall on sub-representable grid steps", () => {
  const ticks = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: 20_000,
  });

  expect(ticks.length).toBeGreaterThan(0);
  expect(
    ticks.every(
      (tick) =>
        Number.isFinite(tick.ageMs) &&
        Number.isFinite(tick.position) &&
        Number.isFinite(tick.opacity),
    ),
  ).toBe(true);
});

test("small origin drift preserves interior tick candidates", () => {
  const before = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: 1_234,
  });
  const after = ghostLegendTicks(5_000, 600, {
    minDistancePx: 24,
    originAgeMs: 1_235,
  });
  const afterAges = new Set(after.map((tick) => tick.ageMs));

  for (const tick of before)
    if (tick.position > 0.05 && tick.position < 0.95 && tick.opacity > 0.1)
      expect(afterAges.has(tick.ageMs)).toBe(true);
});
