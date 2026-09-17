import { describe, expect, test } from "bun:test";
import {
  MIN_VOLUME_LEGEND_TICK_DISTANCE_PX,
  volumeLegendPosition,
  volumeLegendTickValues,
} from "./legendTicks";

describe("volumeLegendTickValues", () => {
  test("keeps selected ticks at least the configured pixel distance apart", () => {
    const maxAbsVolume = 360_000;
    const width = 430;
    const values = volumeLegendTickValues(maxAbsVolume, width);
    const xs = values.map(
      (value) => volumeLegendPosition(value, maxAbsVolume) * width,
    );

    expect(values).toContain(0);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(
        MIN_VOLUME_LEGEND_TICK_DISTANCE_PX - 1e-9,
      );
  });

  test("selects symmetric nice-number families around zero", () => {
    expect(volumeLegendTickValues(360_000, 430)).toEqual([
      -200_000,
      -100_000,
      0,
      100_000,
      200_000,
    ]);
  });

  test("falls through to lower-priority families when major decades do not fit", () => {
    expect(volumeLegendTickValues(360_000, 260)).toEqual([
      -200_000,
      0,
      200_000,
    ]);
  });
});
