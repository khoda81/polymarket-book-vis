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
  test("uses one linear share scale across the whole pressure field", () => {
    expect(sharePressureAreaFraction(25, 100, 50)).toBeCloseTo(25 / 150, 12);
    expect(sharePressureAreaFraction(-75, 100, 50)).toBeCloseTo(75 / 150, 12);
  });

  test("preserves additivity of share area", () => {
    const reference = 100;
    const reserve = 50;
    expect(
      sharePressureAreaFraction(25, reference, reserve) +
        sharePressureAreaFraction(75, reference, reserve),
    ).toBeCloseTo(sharePressureAreaFraction(100, reference, reserve), 12);
  });

  test("maximum observed depth keeps the v/(v+c) softness", () => {
    expect(sharePressureAreaFraction(100, 100, 100)).toBeCloseTo(0.5, 12);
    expect(sharePressureAreaFraction(900, 900, 100)).toBeCloseTo(0.9, 12);
  });

  test("is symmetric in bid and ask sign", () => {
    expect(sharePressureAreaFraction(40, 100, 25)).toBeCloseTo(
      sharePressureAreaFraction(-40, 100, 25),
      12,
    );
  });

  test("row thickness is normalized shares times row height", () => {
    expect(pressureInkThicknessCss(-25, 100, 50, 36)).toBeCloseTo(
      36 * 25 / 150,
      12,
    );
  });

  test("fresh subpixel area becomes fractional center-pixel coverage", () => {
    const profile = pressureInkProfile(-1, 0, 100_000, 100_000, 5, 1, 36);
    const expected = pressureInkThicknessCss(-1, 100_000, 100_000, 36);
    expect(sum(profile)).toBeCloseTo(expected, 6);
    expect(Math.max(...profile)).toBeCloseTo(expected, 6);
  });

  test("fresh raster area is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(-10, 0, 100, 50, 5, 1, 36);
    const twoX = pressureInkProfile(-10, 0, 100, 50, 5, 2, 72);
    const expected = pressureInkThicknessCss(-10, 100, 50, 36);
    expect(sum(oneX)).toBeCloseTo(expected, 6);
    expect(sum(twoX) / 2).toBeCloseTo(expected, 6);
  });

  test("diffusion conserves area before row clipping matters", () => {
    const fresh = pressureInkProfile(-10, 0, 100, 50, 20, 2, 72);
    const aged = pressureInkProfile(-10, 1_000, 100, 50, 20, 2, 72);
    const expected = pressureInkThicknessCss(-10, 100, 50, 36);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(expected, 2);
  });

  test("subpixel sharpening approaches fresh coverage without overshooting", () => {
    const fresh = pressureInkProfile(-1, 0, 100_000, 100_000, 1, 1, 36);
    const slightlyAged = pressureInkProfile(-1, 1, 100_000, 100_000, 1, 1, 36);
    const moreAged = pressureInkProfile(-1, 10, 100_000, 100_000, 1, 1, 36);

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
    expect(sum(pressureInkProfile(-10, Infinity, 100, 50, 5, 1, 36))).toBe(0);
    expect(sum(pressureInkProfile(0, 0, 100, 50, 5, 1, 36))).toBe(0);
  });
});
