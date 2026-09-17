import { describe, expect, test } from "bun:test";
import type { SignedVolumeSegment } from "./signedVolume";
import {
  displacedPressureSegments,
  reprojectPressureFraction,
} from "./resinHistory";

function segment(
  lo: number,
  hi: number,
  volume: number,
  sweepCost = Math.abs(volume),
): SignedVolumeSegment {
  return { lo, hi, volume, sweepCost };
}

describe("resin displacement", () => {
  test("stationary pressure does not accumulate resin", () => {
    const book = [segment(0, 0.4, 100), segment(0.4, 1, 0, 0)];
    expect(displacedPressureSegments(book, book)).toEqual([]);
  });

  test("deposits the previous silhouette where pressure disappears", () => {
    const previous = [segment(0, 0.4, 100), segment(0.4, 1, 0, 0)];
    const next = [segment(0, 1, 0, 0)];
    expect(displacedPressureSegments(previous, next)).toEqual([
      segment(0, 0.4, 100),
    ]);
  });

  test("clips deposits to only the changed part of a cumulative field", () => {
    const previous = [
      segment(0, 0.2, 200),
      segment(0.2, 0.5, 100),
      segment(0.5, 1, 0, 0),
    ];
    const next = [
      segment(0, 0.2, 200),
      segment(0.2, 0.35, 100),
      segment(0.35, 1, 0, 0),
    ];

    expect(displacedPressureSegments(previous, next)).toEqual([
      segment(0.35, 0.5, 100),
    ]);
  });

  test("a thickness change deposits the old shape, not the new one", () => {
    const previous = [segment(0, 0.5, 100), segment(0.5, 1, 0, 0)];
    const next = [segment(0, 0.5, 150), segment(0.5, 1, 0, 0)];
    expect(displacedPressureSegments(previous, next)).toEqual([
      segment(0, 0.5, 100),
    ]);
  });

  test("cost-only changes are invisible to resin", () => {
    const previous = [segment(0, 1, -100, 20)];
    const next = [segment(0, 1, -100, 80)];
    expect(displacedPressureSegments(previous, next)).toEqual([]);
  });
});

describe("resin share-scale reprojection", () => {
  test("identity scale leaves pressure coordinates unchanged", () => {
    expect(reprojectPressureFraction(0.25, 100, 100)).toBeCloseTo(0.25, 12);
    expect(reprojectPressureFraction(0.75, 100, 100)).toBeCloseTo(0.75, 12);
  });

  test("larger reserve contracts an existing silhouette", () => {
    // Q=100 occupies h=1/2 at C=100 and h=1/3 at C=200. Sampling the
    // new 1/3 boundary must therefore land on the old 1/2 boundary.
    expect(reprojectPressureFraction(1 / 3, 100, 200)).toBeCloseTo(0.5, 12);
  });

  test("smaller reserve expands an existing silhouette", () => {
    // The same Q=100 goes from h=1/2 at C=100 to h=2/3 at C=50.
    expect(reprojectPressureFraction(2 / 3, 100, 50)).toBeCloseTo(0.5, 12);
  });

  test("center and row edge remain fixed", () => {
    expect(reprojectPressureFraction(0, 100, 200)).toBe(0);
    expect(reprojectPressureFraction(1, 100, 200)).toBe(1);
  });
});
