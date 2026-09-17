import { describe, expect, test } from "bun:test";
import {
  capitalPressureAreaFraction,
  pressureInkProfile,
  pressureInkThicknessCss,
} from "./pressureInk";

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("pressure ink", () => {
  test("maps sweep capital through the reserve-capital soft ratio", () => {
    expect(capitalPressureAreaFraction(-10, 25, 75)).toBeCloseTo(0.25, 12);
    expect(capitalPressureAreaFraction(10, 75, 25)).toBeCloseTo(0.75, 12);
  });

  test("is symmetric between bid and ask pressure at equal sweep capital", () => {
    expect(capitalPressureAreaFraction(-10, 6, 100)).toBeCloseTo(6 / 106, 12);
    expect(capitalPressureAreaFraction(10, 6, 100)).toBeCloseTo(6 / 106, 12);
  });

  test("approaches full-row pressure smoothly without an arbitrary hard cap", () => {
    expect(capitalPressureAreaFraction(-10, 100, 100)).toBeCloseTo(0.5, 12);
    expect(capitalPressureAreaFraction(-10, 900, 100)).toBeCloseTo(0.9, 12);
    expect(capitalPressureAreaFraction(-10, Infinity, 100)).toBe(1);
  });

  test("legacy samples with unknown sweep cost do not invent capital pressure", () => {
    expect(capitalPressureAreaFraction(10, null, 100)).toBe(0);
  });

  test("row thickness is the capital-pressure fraction times row height", () => {
    expect(pressureInkThicknessCss(-10, 6, 100, 36)).toBeCloseTo(36 * 6 / 106, 12);
  });

  test("fresh subpixel area becomes fractional center-pixel coverage", () => {
    const reserve = 100_000;
    const profile = pressureInkProfile(-1, 0.6, 0.6, 1, 0, reserve, 5, 1, 36);
    const expected = pressureInkThicknessCss(-1, 0.6, reserve, 36);
    expect(sum(profile)).toBeCloseTo(expected, 6);
    expect(Math.max(...profile)).toBeCloseTo(expected, 6);
  });

  test("fresh raster area is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 5, 1, 36);
    const twoX = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 5, 2, 72);
    const expected = pressureInkThicknessCss(-10, 6, 100, 36);
    expect(sum(oneX)).toBeCloseTo(expected, 6);
    expect(sum(twoX) / 2).toBeCloseTo(expected, 6);
  });

  test("diffusion conserves area before row clipping matters", () => {
    const fresh = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 20, 2, 72);
    const aged = pressureInkProfile(-10, 6, 0.6, 1, 1_000, 100, 20, 2, 72);
    const expected = pressureInkThicknessCss(-10, 6, 100, 36);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(expected, 2);
  });

  test("subpixel sharpening approaches fresh coverage without overshooting", () => {
    const reserve = 100_000;
    const fresh = pressureInkProfile(-1, 0.6, 0.6, 1, 0, reserve, 1, 1, 36);
    const slightlyAged = pressureInkProfile(-1, 0.6, 0.6, 1, 1, reserve, 1, 1, 36);
    const moreAged = pressureInkProfile(-1, 0.6, 0.6, 1, 10, reserve, 1, 1, 36);

    const freshPeak = Math.max(...fresh);
    expect(Math.max(...slightlyAged)).toBeLessThanOrEqual(freshPeak + 1e-6);
    expect(Math.max(...moreAged)).toBeLessThanOrEqual(Math.max(...slightlyAged) + 1e-6);
  });

  test("legacy Canvas fallback still conserves subpixel area", () => {
    const profile = pressureInkProfile(100, 0, 10_000, 5, 1, 36);
    const expected = 36 * (100 / (100 + 360_000));
    expect(sum(profile)).toBeCloseTo(expected, 6);
  });

  test("infinite age and zero pressure render no ink", () => {
    expect(sum(pressureInkProfile(-10, 6, 0.6, 1, Infinity, 100, 5, 1, 36))).toBe(0);
    expect(sum(pressureInkProfile(0, 0, 0, 1, 0, 100, 5, 1, 36))).toBe(0);
  });
});
