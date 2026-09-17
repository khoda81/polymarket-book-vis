import { describe, expect, test } from "bun:test";
import {
  pressureInkProfile,
  pressureInkThicknessCss,
} from "./pressureInk";

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("pressure ink", () => {
  test("maps volume linearly to opaque CSS-pixel-equivalents", () => {
    expect(pressureInkThicknessCss(0, 10_000, 36)).toBe(0);
    expect(pressureInkThicknessCss(5_000, 10_000, 36)).toBe(0.5);
    expect(pressureInkThicknessCss(-30_000, 10_000, 36)).toBe(3);
    expect(pressureInkThicknessCss(1_000_000, 10_000, 36)).toBe(36);
  });

  test("fresh subpixel volume becomes fractional center-pixel coverage", () => {
    const profile = pressureInkProfile(5_000, 0, 10_000, 5, 1, 36);
    expect(sum(profile)).toBeCloseTo(0.5, 6);
    expect(Math.max(...profile)).toBeCloseTo(0.5, 6);
  });

  test("fresh raster mass is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(25_000, 0, 10_000, 5, 1, 36);
    const twoX = pressureInkProfile(25_000, 0, 10_000, 5, 2, 72);
    expect(sum(oneX)).toBeCloseTo(2.5, 6);
    expect(sum(twoX) / 2).toBeCloseTo(2.5, 6);
  });

  test("diffusion spreads the same pressure before row clipping matters", () => {
    const fresh = pressureInkProfile(40_000, 0, 10_000, 20, 2, 72);
    const aged = pressureInkProfile(40_000, 1_000, 10_000, 20, 2, 72);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(4, 2);
  });

  test("infinite age and unknown pressure render no ink", () => {
    const profile = pressureInkProfile(40_000, Infinity, 10_000, 5, 1, 36);
    expect(sum(profile)).toBe(0);
  });
});
