import { expect, test } from "bun:test";
import { pressureVolumeAtY } from "./ageStripPressureProjection";
import {
  DEFAULT_AGE_ROW_ORIENTATION,
  inferAgeRowOrientation,
} from "./ageStripOrientation";

const defaultOrientation = DEFAULT_AGE_ROW_ORIENTATION;

test("event orientation inference only opts out for strong structural hints", () => {
  expect(
    inferAgeRowOrientation({
      sortBy: "ascending",
      title: "US-Iran Final Nuclear Deal by…?",
    }),
  ).toBe("negative-above");
  expect(
    inferAgeRowOrientation({
      sortBy: "ascending",
      title: "Israel x Iran ceasefire continues through...?",
    }),
  ).toBe("positive-above");
  expect(
    inferAgeRowOrientation({
      sortBy: "price",
      title: "Where will the next meeting take place?",
    }),
  ).toBe("positive-above");
  expect(
    inferAgeRowOrientation({
      sortBy: "ascending",
      title: "Unknown ascending grouped market",
    }),
  ).toBe(defaultOrientation);
});

test("screen y exactly inverts the renderer's volume transfer", () => {
  const rowHeight = 28;
  const halfHeight = rowHeight / 2;
  const reserveShares = rowHeight * 100;
  const center = 14;

  // Halfway to the row edge means pressure = 0.5. With reserve
  // R = 28 * 100 = 2800, v/sqrt(v^2 + R^2)=0.5 iff
  // v = R / sqrt(3).
  expect(
    pressureVolumeAtY(
      center + halfHeight / 2,
      center,
      halfHeight,
      reserveShares,
    ),
  ).toBeCloseTo(2_800 / Math.sqrt(3));

  expect(
    pressureVolumeAtY(
      center - halfHeight / 2,
      center,
      halfHeight,
      reserveShares,
    ),
  ).toBeCloseTo(2_800 / Math.sqrt(3));

  expect(
    pressureVolumeAtY(center + halfHeight, center, halfHeight, reserveShares),
  ).toBeNull();
});

test("asymmetric snapped half-rows invert the same share pressure", () => {
  const center = 29;
  const upperHeight = 26;
  const lowerHeight = 27;
  const reserveShares = 48 * 100;

  expect(
    pressureVolumeAtY(
      center - upperHeight / 2,
      center,
      upperHeight,
      reserveShares,
    ),
  ).toBeCloseTo(reserveShares / Math.sqrt(3));
  expect(
    pressureVolumeAtY(
      center + lowerHeight / 2,
      center,
      lowerHeight,
      reserveShares,
    ),
  ).toBeCloseTo(reserveShares / Math.sqrt(3));
  expect(
    pressureVolumeAtY(center + lowerHeight, center, lowerHeight, reserveShares),
  ).toBeNull();
});
