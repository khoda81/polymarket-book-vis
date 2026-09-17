import { describe, expect, test } from "bun:test";
import type { SignedVolumeSegment } from "./signedVolume";
import { displacedPressureSegments } from "./resinHistory";

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
