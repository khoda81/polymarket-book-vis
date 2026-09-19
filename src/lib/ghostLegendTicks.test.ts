import { expect, test } from "bun:test";
import {
  ageAtGhostPosition,
  formatDurationTick,
  ghostLegendTicks,
  ghostPositionForAge,
} from "./ghostLegendTicks";

test("ghost age transform is invertible", () => {
  for (const age of [1, 10, 1_000, 60_000, 3_600_000]) {
    const p = ghostPositionForAge(age, 5_000);
    expect(ageAtGhostPosition(p, 5_000)).toBeCloseTo(age);
  }
});

test("duration ticks use human unit families and fade by local spacing", () => {
  const ticks = ghostLegendTicks(60 * 60 * 1_000, 430);
  expect(ticks.length).toBeGreaterThan(2);
  expect(
    ticks.some((tick) => /h$/.test(tick.label)),
  ).toBe(true);
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
  expect(formatDurationTick(0.1)).toBe("100µs");
  expect(formatDurationTick(1_000)).toBe("1s");
  expect(formatDurationTick(60 * 60 * 1_000)).toBe("1h");
  expect(formatDurationTick(365 * 24 * 60 * 60 * 1_000)).toBe("1y");
});
