import { describe, expect, test } from "bun:test";
import {
  pressureInkAreaFraction,
  pressureInkProfile,
  pressureInkThicknessCss,
} from "./pressureInk";

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("pressure ink", () => {
  test("maps volume to a soft-saturating row-area fraction", () => {
    expect(pressureInkAreaFraction(0, 10_000)).toBe(0);
    expect(pressureInkAreaFraction(10_000, 10_000)).toBe(0.5);
    expect(pressureInkAreaFraction(-30_000, 10_000)).toBe(0.75);
    expect(pressureInkAreaFraction(Infinity, 10_000)).toBe(1);

    expect(pressureInkThicknessCss(10_000, 10_000, 36)).toBe(18);
    expect(pressureInkThicknessCss(-30_000, 10_000, 36)).toBe(27);
  });

  test("fresh subpixel area becomes fractional center-pixel coverage", () => {
    const profile = pressureInkProfile(100, 0, 10_000, 5, 1, 36);
    const expected = 36 * (100 / 10_100);
    expect(sum(profile)).toBeCloseTo(expected, 6);
    expect(Math.max(...profile)).toBeCloseTo(expected, 6);
  });

  test("fresh raster area is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(25_000, 0, 10_000, 5, 1, 36);
    const twoX = pressureInkProfile(25_000, 0, 10_000, 5, 2, 72);
    const expected = 36 * (25_000 / 35_000);
    expect(sum(oneX)).toBeCloseTo(expected, 6);
    expect(sum(twoX) / 2).toBeCloseTo(expected, 6);
  });

  test("diffusion spreads approximately the same area before row clipping matters", () => {
    const fresh = pressureInkProfile(1_000, 0, 10_000, 20, 2, 72);
    const aged = pressureInkProfile(1_000, 1_000, 10_000, 20, 2, 72);
    const expected = 36 * (1_000 / 11_000);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(expected, 2);
  });

  test("infinite age and zero pressure render no ink", () => {
    expect(sum(pressureInkProfile(40_000, Infinity, 10_000, 5, 1, 36))).toBe(0);
    expect(sum(pressureInkProfile(0, 0, 10_000, 5, 1, 36))).toBe(0);
  });
});
