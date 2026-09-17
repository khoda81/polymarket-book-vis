import { describe, expect, test } from "bun:test";
import {
  MIN_VOLUME_LEGEND_TICK_DISTANCE_PX,
  volumeLegendPosition,
  volumeLegendTickValues,
} from "./legendTicks";

describe("volumeLegendTickValues", () => {
  test("keeps selected ticks at least the configured pixel distance apart", () => {
    const softLimit = 360_000;
    const width = 430;
    const values = volumeLegendTickValues(softLimit, width);
    const xs = values.map(
      (value) => volumeLegendPosition(value, softLimit) * width,
    );

    expect(values).toContain(0);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(
        MIN_VOLUME_LEGEND_TICK_DISTANCE_PX - 1e-9,
      );
  });

  test("maps the half-area soft limit to quarter/three-quarter positions", () => {
    expect(volumeLegendPosition(-360_000, 360_000)).toBe(0.25);
    expect(volumeLegendPosition(0, 360_000)).toBe(0.5);
    expect(volumeLegendPosition(360_000, 360_000)).toBe(0.75);
  });

  test("selects symmetric nice-number families around zero", () => {
    expect(volumeLegendTickValues(360_000, 430)).toEqual([
      -1_000_000,
      -200_000,
      0,
      200_000,
      1_000_000,
    ]);
  });

  test("falls through to lower-density ticks on narrower legends", () => {
    expect(volumeLegendTickValues(360_000, 260)).toEqual([
      -1_000_000,
      0,
      1_000_000,
    ]);
  });
});
