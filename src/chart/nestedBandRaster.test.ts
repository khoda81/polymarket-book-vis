import { expect, test } from "bun:test";
import {
  rasterizeNestedBands,
  rasterizeNestedBandsInto,
} from "./nestedBandRaster";

const cyan = { r: 0, g: 1, b: 1 };

test("subpixel opaque band preserves geometric coverage", () => {
  const pixels = rasterizeNestedBands(
    [{ halfThickness: 0.25, alpha: 1, color: cyan }],
    0.5,
    0,
    1,
  );

  expect(pixels[3]).toBeCloseTo(128, 0);
});

test("nested subpixel bands do not double-charge shared coverage", () => {
  const pixels = rasterizeNestedBands(
    [
      { halfThickness: 0.3, alpha: 0.5, color: cyan },
      { halfThickness: 0.2, alpha: 1, color: cyan },
    ],
    0.5,
    0,
    1,
  );

  // Exact geometry:
  // 0.4 px live at alpha 1 + 0.2 px ghost-only at alpha 0.5 = 0.5.
  // Independent rectangle anti-aliasing would incorrectly produce ~0.58.
  expect(pixels[3]).toBeCloseTo(128, 0);
});

test("a full device pixel remains fully opaque", () => {
  const pixels = rasterizeNestedBands(
    [{ halfThickness: 0.5, alpha: 1, color: cyan }],
    0.5,
    0,
    1,
  );

  expect(pixels[3]).toBe(255);
});

test("reused raster buffer clears pixels from the previous cell", () => {
  const buffer = new Uint8ClampedArray(8);
  const cyan = { r: 0, g: 1, b: 1 };

  rasterizeNestedBandsInto(
    [{ halfThickness: 1, alpha: 1, color: cyan }],
    1,
    0,
    2,
    buffer,
  );
  expect(buffer[3]).toBe(255);
  expect(buffer[7]).toBe(255);

  rasterizeNestedBandsInto([], 1, 0, 2, buffer);
  expect([...buffer]).toEqual(new Array(8).fill(0));
});
