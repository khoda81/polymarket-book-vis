import { describe, expect, test } from "bun:test";
import {
  MIN_VOLUME_LEGEND_TICK_DISTANCE_PX,
  volumeLegendTickValues,
} from "./legendTicks";
import { signedVolumePosition } from "./signedVolume";

describe("volumeLegendTickValues", () => {
  test("keeps selected ticks at least the configured pixel distance apart", () => {
    const softLimit = 18.25;
    const width = 430;
    const values = volumeLegendTickValues(softLimit, width);
    const xs = values.map(
      (value) => signedVolumePosition(value, softLimit) * width,
    );

    expect(values).toContain(0);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(
        MIN_VOLUME_LEGEND_TICK_DISTANCE_PX - 1e-9,
      );
  });

  test("selects symmetric nice-number families around zero", () => {
    expect(volumeLegendTickValues(18.25, 430)).toEqual([
      -100, -10, 0, 10, 100,
    ]);
  });

  test("falls through to lower-priority families when major decades do not fit", () => {
    expect(volumeLegendTickValues(18.25, 260)).toEqual([-50, 0, 50]);
  });
});
