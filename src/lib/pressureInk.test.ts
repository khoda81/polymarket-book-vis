import { describe, expect, test } from "bun:test";
import {
  pressureInkProfile,
  pressureInkThicknessCss,
  sharePressureAreaFraction,
} from "./pressureInk";

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("pressure ink", () => {
  test("maps cumulative shares through the local soft ratio", () => {
    expect(sharePressureAreaFraction(25, 75)).toBeCloseTo(0.25, 12);
    expect(sharePressureAreaFraction(-75, 25)).toBeCloseTo(0.75, 12);
  });

  test("the reserve share count maps to half-row pressure", () => {
    expect(sharePressureAreaFraction(100, 100)).toBeCloseTo(0.5, 12);
    expect(sharePressureAreaFraction(-100, 100)).toBeCloseTo(0.5, 12);
  });

  test("approaches full pressure smoothly without a hard cap", () => {
    expect(sharePressureAreaFraction(900, 100)).toBeCloseTo(0.9, 12);
    expect(sharePressureAreaFraction(Infinity, 100)).toBe(1);
  });

  test("is symmetric in bid and ask sign", () => {
    expect(sharePressureAreaFraction(40, 25)).toBeCloseTo(
      sharePressureAreaFraction(-40, 25),
      12,
    );
  });

  test("row thickness is the soft share fraction times row height", () => {
    expect(pressureInkThicknessCss(-25, 75, 36)).toBeCloseTo(9, 12);
  });

  test("fresh subpixel area becomes fractional center-pixel coverage", () => {
    const profile = pressureInkProfile(-1, 0, 100_000, 5, 1, 36);
    const reserve = 100_000 * 36;
    const expected = pressureInkThicknessCss(-1, reserve, 36);
    expect(sum(profile)).toBeCloseTo(expected, 6);
    expect(Math.max(...profile)).toBeCloseTo(expected, 6);
  });

  test("fresh raster area is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(-10, 0, 100, 5, 1, 36);
    const twoX = pressureInkProfile(-10, 0, 100, 5, 2, 72);
    const expected = pressureInkThicknessCss(-10, 3_600, 36);
    expect(sum(oneX)).toBeCloseTo(expected, 6);
    expect(sum(twoX) / 2).toBeCloseTo(expected, 6);
  });

  test("diffusion conserves area before row clipping matters", () => {
    const fresh = pressureInkProfile(-10, 0, 100, 20, 2, 72);
    const aged = pressureInkProfile(-10, 1_000, 100, 20, 2, 72);
    const expected = pressureInkThicknessCss(-10, 3_600, 36);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(expected, 2);
  });

  test("subpixel sharpening approaches fresh coverage without overshooting", () => {
    const fresh = pressureInkProfile(-1, 0, 100_000, 1, 1, 36);
    const slightlyAged = pressureInkProfile(-1, 1, 100_000, 1, 1, 36);
    const moreAged = pressureInkProfile(-1, 10, 100_000, 1, 1, 36);

    const freshPeak = Math.max(...fresh);
    expect(Math.max(...slightlyAged)).toBeLessThanOrEqual(freshPeak + 1e-6);
    expect(Math.max(...moreAged)).toBeLessThanOrEqual(Math.max(...slightlyAged) + 1e-6);
  });

  test("infinite age and zero pressure render no ink", () => {
    expect(sum(pressureInkProfile(-10, Infinity, 100, 5, 1, 36))).toBe(0);
    expect(sum(pressureInkProfile(0, 0, 100, 5, 1, 36))).toBe(0);
  });
});
