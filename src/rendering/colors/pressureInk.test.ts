import { describe, expect, test } from "bun:test";
import {
  pressureInkThicknessCss,
  sharePressureAreaFraction,
} from "./pressureInk";

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
});
