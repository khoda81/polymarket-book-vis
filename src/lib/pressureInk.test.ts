import { describe, expect, test } from "bun:test";
import {
  kellyPressureAreaFraction,
  pressureInkProfile,
  pressureInkThicknessCss,
} from "./pressureInk";

function sum(values: Float32Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

describe("pressure ink", () => {
  test("derives ask resistance from Kelly-optimal YES allocation", () => {
    // Buy 10 YES for $6 total, with the marginal ask at 0.6 and $100 bankroll.
    // W(no)=94, W(yes)=104, so Kelly indifference gives q=0.624.
    // Normalized conviction above market: (0.624-0.6)/(1-0.6)=0.06.
    expect(kellyPressureAreaFraction(-10, 6, 0.6, 1, 100)).toBeCloseTo(0.06, 12);
  });

  test("derives bid support symmetrically through the equivalent NO sweep", () => {
    // Selling 10 YES into a 0.4 bid is equivalent to buying 10 NO at 0.6.
    // The required normalized bearish conviction is therefore also 0.06.
    expect(kellyPressureAreaFraction(10, 6, 0, 0.4, 100)).toBeCloseTo(0.06, 12);
  });

  test("saturates only when sweeping the resting side exhausts bankroll", () => {
    expect(kellyPressureAreaFraction(-10, 100, 0.6, 1, 100)).toBe(1);
    expect(kellyPressureAreaFraction(10, 101, 0, 0.4, 100)).toBe(1);
  });

  test("legacy samples with unknown sweep cost do not invent Kelly magnitude", () => {
    expect(kellyPressureAreaFraction(10, null, 0, 0.4, 100)).toBe(0);
  });

  test("row thickness is the Kelly conviction fraction times row height", () => {
    expect(pressureInkThicknessCss(-10, 6, 0.6, 1, 100, 36)).toBeCloseTo(2.16, 12);
  });

  test("fresh subpixel area becomes fractional center-pixel coverage", () => {
    // Choose a very large bankroll so the Kelly fraction is subpixel.
    const profile = pressureInkProfile(-1, 0.6, 0.6, 1, 10_000, 100_000, 5, 1, 36);
    const expected = pressureInkThicknessCss(-1, 0.6, 0.6, 1, 100_000, 36);
    expect(sum(profile)).toBeCloseTo(expected, 6);
    expect(Math.max(...profile)).toBeCloseTo(expected, 6);
  });

  test("fresh raster area is independent of device-pixel ratio", () => {
    const oneX = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 5, 1, 36);
    const twoX = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 5, 2, 72);
    const expected = pressureInkThicknessCss(-10, 6, 0.6, 1, 100, 36);
    expect(sum(oneX)).toBeCloseTo(expected, 6);
    expect(sum(twoX) / 2).toBeCloseTo(expected, 6);
  });

  test("diffusion conserves area before row clipping matters", () => {
    const fresh = pressureInkProfile(-10, 6, 0.6, 1, 0, 100, 20, 2, 72);
    const aged = pressureInkProfile(-10, 6, 0.6, 1, 1_000, 100, 20, 2, 72);
    const expected = pressureInkThicknessCss(-10, 6, 0.6, 1, 100, 36);

    expect(Math.max(...aged)).toBeLessThan(Math.max(...fresh));
    expect(sum(aged) / 2).toBeCloseTo(expected, 2);
  });

  test("subpixel sharpening approaches fresh coverage without overshooting", () => {
    const bankroll = 100_000;
    const fresh = pressureInkProfile(-1, 0.6, 0.6, 1, 0, bankroll, 1, 1, 36);
    const slightlyAged = pressureInkProfile(-1, 0.6, 0.6, 1, 1, bankroll, 1, 1, 36);
    const moreAged = pressureInkProfile(-1, 0.6, 0.6, 1, 10, bankroll, 1, 1, 36);

    const freshPeak = Math.max(...fresh);
    expect(Math.max(...slightlyAged)).toBeLessThanOrEqual(freshPeak + 1e-6);
    expect(Math.max(...moreAged)).toBeLessThanOrEqual(Math.max(...slightlyAged) + 1e-6);
  });

  test("infinite age and zero pressure render no ink", () => {
    expect(sum(pressureInkProfile(-10, 6, 0.6, 1, Infinity, 100, 5, 1, 36))).toBe(0);
    expect(sum(pressureInkProfile(0, 0, 0, 1, 0, 100, 5, 1, 36))).toBe(0);
  });
});
