import { expect, test } from "bun:test";
import { rasterizePressureBandsInto } from "./pressureFieldRaster";

const cyan = { r: 0, g: 1, b: 1 };

function options() {
  return {
    positiveColor: cyan,
    negativeColor: cyan,
    reserveShares: 1,
    rowHeightCss: 1,
    dpr: 1,
    ghostHalfLifeMs: 1_000,
    nowMs: 1_000,
    visibleSinceMs: Number.NEGATIVE_INFINITY,
    centerDevice: 0.5,
    topDevice: 0,
    heightDevice: 1,
  } as const;
}

test("fresh subpixel observation preserves geometric coverage", () => {
  const result = new Uint8ClampedArray(4);
  rasterizePressureBandsInto(
    [
      {
        loVolume: 0,
        hiVolume: 1,
        side: 1,
        validThroughMs: 1_000,
      },
    ],
    options(),
    result,
  );

  expect(result[3]).toBeCloseTo(128, 0);
});

test("older outer observation decays without double-charging one pixel", () => {
  const result = new Uint8ClampedArray(4);
  rasterizePressureBandsInto(
    [
      {
        loVolume: 0,
        hiVolume: 2 / 3,
        side: 1,
        validThroughMs: 1_000,
      },
      {
        loVolume: 2 / 3,
        hiVolume: 1.5,
        side: -1,
        validThroughMs: 0,
      },
    ],
    options(),
    result,
  );

  // Inner thickness = 0.4 px at alpha 1. Outer 0.2 px is one half-life old:
  // 0.4 * 1 + 0.2 * 0.5 = 0.5 final pixel alpha.
  expect(result[3]).toBeCloseTo(128, 0);
});

test("reused pressure column clears old pixels", () => {
  const result = new Uint8ClampedArray(4);
  rasterizePressureBandsInto(
    [
      {
        loVolume: 0,
        hiVolume: 1,
        side: 1,
        validThroughMs: 1_000,
      },
    ],
    options(),
    result,
  );
  expect(result[3]).toBeGreaterThan(0);

  rasterizePressureBandsInto([], options(), result);
  expect([...result]).toEqual([0, 0, 0, 0]);
});
