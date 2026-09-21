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
    visibleGhostSinceMs: Number.NEGATIVE_INFINITY,
    centerDevice: 0.5,
    topDevice: 0,
    heightDevice: 1,
  } as const;
}

test("subpixel live shell preserves geometric coverage", () => {
  const result = new Uint8ClampedArray(4);
  rasterizePressureBandsInto(
    [
      {
        loVolume: 0,
        hiVolume: 1,
        side: 1,
        state: { kind: "live" },
      },
    ],
    options(),
    result,
  );

  // pressureInkThicknessCss(1, 1, 1) = 0.5 CSS px.
  expect(result[3]).toBeCloseTo(128, 0);
});

test("disjoint live and ghost shells cannot double-charge one pixel", () => {
  const result = new Uint8ClampedArray(4);
  rasterizePressureBandsInto(
    [
      {
        loVolume: 0,
        hiVolume: 2 / 3,
        side: 1,
        state: { kind: "live" },
      },
      {
        loVolume: 2 / 3,
        hiVolume: 1.5,
        side: -1,
        state: { kind: "ghost", sinceMs: 0 },
      },
    ],
    options(),
    result,
  );

  // Inner live thickness = 0.4 px. Outer total thickness = 0.6 px.
  // The remaining 0.2 px belongs to a ghost at alpha 0.5:
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
        state: { kind: "live" },
      },
    ],
    options(),
    result,
  );
  expect(result[3]).toBeGreaterThan(0);

  rasterizePressureBandsInto([], options(), result);
  expect([...result]).toEqual([0, 0, 0, 0]);
});
