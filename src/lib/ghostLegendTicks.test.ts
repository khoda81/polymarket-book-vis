import { expect, test } from "bun:test";
import {
  ageAtGhostPosition,
  durationRefinementSteps,
  formatDurationTick,
  ghostLegendTicks,
  ghostPositionForAge,
} from "./ghostLegendTicks";

function ticks(
  halfLifeMs: number,
  widthPx: number,
  originAgeMs = 0,
  minSpacingPx = 24,
) {
  return ghostLegendTicks(halfLifeMs, widthPx, {
    minSpacingPx,
    fullOpacitySpacingPx: minSpacingPx * 2,
    originAgeMs,
    dpr: 1,
  });
}

test("ghost age transform is invertible", () => {
  for (const age of [1, 10, 1_000, 60_000, 100_000]) {
    const p = ghostPositionForAge(age, 5_000);
    expect(ageAtGhostPosition(p, 5_000)).toBeCloseTo(age);
  }
  expect(ageAtGhostPosition(1, 5_000)).toBe(Number.POSITIVE_INFINITY);
});

test("time tick steps form one recursive refinement lattice", () => {
  const steps = durationRefinementSteps();

  for (let index = 0; index + 1 < steps.length; index++) {
    const coarse = steps[index]!;
    const fine = steps[index + 1]!;
    const ratio = coarse / fine;
    const integerRatio = Math.round(ratio);

    expect(coarse).toBeGreaterThan(fine);
    expect(integerRatio).toBeGreaterThanOrEqual(2);
    expect(Math.abs(ratio - integerRatio)).toBeLessThan(1e-10);
  }
});

test("duration ticks use human unit families and fade by local density", () => {
  const values = ticks(60 * 60 * 1_000, 430, 0, 48);
  expect(values.length).toBeGreaterThan(2);
  expect(values.some((tick) => /h$/.test(tick.label))).toBe(true);
  expect(
    values.every(
      (tick) =>
        tick.position >= 0 &&
        tick.position < 1 &&
        tick.opacity > 0 &&
        tick.opacity <= 1,
    ),
  ).toBe(true);
  expect(values.some((tick) => tick.opacity < 1)).toBe(true);
});

test("duration labels remain readable below milliseconds and above months", () => {
  expect(formatDurationTick(0)).toBe("now");
  expect(formatDurationTick(-50)).toBe("−50ms");
  expect(formatDurationTick(0.1)).toBe("100µs");
  expect(formatDurationTick(1_000)).toBe("1s");
  expect(formatDurationTick(60 * 60 * 1_000)).toBe("1h");
  expect(formatDurationTick(360 * 24 * 60 * 60 * 1_000)).toBe("1y");
});

test("absolute-age ticks are reprojected when the newest observation gets older", () => {
  const fresh = ticks(5_000, 600, 0);
  const stale = ticks(5_000, 600, 1_000);

  const sharedAge = fresh
    .map((tick) => tick.ageMs)
    .find((age) => stale.some((tick) => tick.ageMs === age));
  expect(sharedAge).toBeDefined();

  const freshTick = fresh.find((tick) => tick.ageMs === sharedAge)!;
  const staleTick = stale.find((tick) => tick.ageMs === sharedAge)!;
  expect(staleTick.position).toBeLessThan(freshTick.position);

  const exact = ghostPositionForAge(sharedAge! - 1_000, 5_000);
  expect(Math.abs(staleTick.position - exact)).toBeLessThanOrEqual(0.5 / 600);
  expect(staleTick.label).toBe(formatDurationTick(sharedAge!));
});

test("signed clock offsets put now in the physical pixel covering it", () => {
  const values = ticks(5_000, 600, -50);
  const now = values.find((tick) => tick.ageMs === 0);
  expect(now).toBeDefined();
  expect(now!.label).toBe("now");

  const exact = ghostPositionForAge(50, 5_000);
  expect(Math.abs(now!.position - exact)).toBeLessThanOrEqual(0.5 / 600);
});

test("future clock offsets can expose negative tick values", () => {
  const values = ticks(5_000, 600, -1_500);
  expect(values.some((tick) => tick.ageMs < 0)).toBe(true);
  expect(values.some((tick) => tick.label.startsWith("−"))).toBe(true);
});

test("500ms candidate survives small clock-origin drift", () => {
  for (const originAgeMs of [0, 1, 2, 3])
    expect(
      ticks(5_000, 600, originAgeMs).some((tick) => tick.ageMs === 500),
    ).toBe(true);
});

test("large clock offsets remain finite and bounded", () => {
  const values = ticks(5_000, 600, 20_000);
  expect(values.length).toBeGreaterThan(0);
  expect(
    values.every(
      (tick) =>
        Number.isFinite(tick.ageMs) &&
        Number.isFinite(tick.position) &&
        Number.isFinite(tick.opacity),
    ),
  ).toBe(true);
});

test("small origin drift preserves interior tick candidates", () => {
  const before = ticks(5_000, 600, 1_234);
  const after = ticks(5_000, 600, 1_235);
  const afterAges = new Set(after.map((tick) => tick.ageMs));

  for (const tick of before)
    if (tick.position > 0.05 && tick.position < 0.95 && tick.opacity > 0.1)
      expect(afterAges.has(tick.ageMs)).toBe(true);
});
