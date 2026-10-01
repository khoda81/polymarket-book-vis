import { describe, expect, test } from "bun:test";
import {
  pressureInkThicknessCss,
  sharePressureAreaFraction,
  shareVolumeAtPressure,
  signedSharePressure,
} from "./pressureInk";

describe("pressure ink", () => {
  test("uses smooth vector normalization for signed pressure", () => {
    expect(signedSharePressure(25, 75)).toBeCloseTo(1 / Math.sqrt(10), 12);
    expect(signedSharePressure(-75, 25)).toBeCloseTo(-3 / Math.sqrt(10), 12);
  });

  test("the reserve share count maps to one over sqrt two", () => {
    expect(sharePressureAreaFraction(100, 100)).toBeCloseTo(
      1 / Math.sqrt(2),
      12,
    );
    expect(sharePressureAreaFraction(-100, 100)).toBeCloseTo(
      1 / Math.sqrt(2),
      12,
    );
  });

  test("approaches full pressure smoothly without a hard cap", () => {
    expect(sharePressureAreaFraction(900, 100)).toBeCloseTo(
      9 / Math.sqrt(82),
      12,
    );
    expect(sharePressureAreaFraction(Infinity, 100)).toBe(1);
  });

  test("is odd before taking row-space magnitude", () => {
    expect(signedSharePressure(40, 25)).toBeCloseTo(
      -signedSharePressure(-40, 25),
      12,
    );
  });

  test("signed transform round-trips finite pressure", () => {
    const reserve = 1_500;
    for (const volume of [-1e6, -1000, -1, 0, 1, 1000, 1e6])
      expect(
        shareVolumeAtPressure(signedSharePressure(volume, reserve), reserve),
      ).toBeCloseTo(volume, 4);

    expect(shareVolumeAtPressure(-1, reserve)).toBe(Number.NEGATIVE_INFINITY);
    expect(shareVolumeAtPressure(1, reserve)).toBe(Number.POSITIVE_INFINITY);
  });

  test("row thickness is the smooth share fraction times row height", () => {
    expect(pressureInkThicknessCss(-25, 75, 36)).toBeCloseTo(
      36 / Math.sqrt(10),
      12,
    );
  });
});
