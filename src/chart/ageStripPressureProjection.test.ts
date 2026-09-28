import { expect, test } from "bun:test";
import {
  agePressurePerspective,
  agePressureSourceSideAtY,
  pressurePriceAtDisplayX,
  pressureVolumeAtY,
  semanticPriceAtDisplayX,
  sourcePriceAtDisplayX,
} from "./ageStripPressureProjection";
import { PRICE_SCALE } from "@/lib/price";
import {
  defaultOrientation,
  inferAgeRowOrientation,
} from "./ageStripOrientation";

const defaultOrientation = DEFAULT_AGE_ROW_ORIENTATION;

test("geometry source and displayed token semantics are complementary", () => {
  expect(
    agePressurePerspective("primary", defaultOrientation),
  ).toMatchObject({
    sourceSide: "primary",
    semanticSide: "opposite",
    mirrorPrice: true,
    yDirection: -1,
    colorSign: -1,
  });
  expect(
    agePressurePerspective("opposite", defaultOrientation),
  ).toMatchObject({
    sourceSide: "opposite",
    semanticSide: "primary",
    mirrorPrice: false,
    yDirection: 1,
    colorSign: 1,
  });

  expect(
    agePressureSourceSideAtY(13, 14, defaultOrientation),
  ).toBe("primary");
  expect(
    agePressureSourceSideAtY(15, 14, defaultOrientation),
  ).toBe("opposite");
});

test("row orientation flips renderer and hover semantics together", () => {
  expect(DEFAULT_AGE_ROW_ORIENTATION).toBe("negative-above");

  const flipped = "positive-above" as const;
  expect(agePressurePerspective("primary", flipped)).toMatchObject({
    semanticSide: "opposite",
    yDirection: 1,
    colorSign: -1,
  });
  expect(agePressurePerspective("opposite", flipped)).toMatchObject({
    semanticSide: "primary",
    yDirection: -1,
    colorSign: 1,
  });

  expect(agePressureSourceSideAtY(15, 14, flipped)).toBe("primary");
  expect(agePressureSourceSideAtY(13, 14, flipped)).toBe("opposite");
});

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

test("semantic price complements the source field without moving geometry", () => {
  const primarySource = agePressurePerspective(
    "primary",
    defaultOrientation,
  );
  const oppositeSource = agePressurePerspective(
    "opposite",
    defaultOrientation,
  );

  // Primary-source geometry is mirrored: source YES@0.75 is drawn at x=.25,
  // but that screen half is semantically the opposite token at .25.
  expect(sourcePriceAtDisplayX(0.25, primarySource)).toBe(0.75);
  expect(semanticPriceAtDisplayX(0.25, primarySource)).toBe(0.25);

  // Opposite-source geometry is direct: source NO@0.25 stays at x=.25,
  // while the displayed primary-token semantic price is .75.
  expect(sourcePriceAtDisplayX(0.25, oppositeSource)).toBe(0.25);
  expect(semanticPriceAtDisplayX(0.25, oppositeSource)).toBe(0.75);

  // Field lookup remains in the original source coordinates, preserving shape.
  expect(Number(pressurePriceAtDisplayX(0.25, primarySource))).toBe(
    Math.floor(0.75 * PRICE_SCALE),
  );
  expect(Number(pressurePriceAtDisplayX(0.25, oppositeSource))).toBe(
    Math.floor(0.25 * PRICE_SCALE),
  );
});

test("screen y exactly inverts the renderer's volume transfer", () => {
  const rowHeight = 28;
  const volumePerCssPixel = 100;
  const center = 14;

  // Halfway to the row edge means pressure = 0.5. With reserve
  // s = 28 * 100 = 2800, v/(v+s)=0.5 iff v=2800.
  expect(
    pressureVolumeAtY(
      center + rowHeight / 4,
      center,
      rowHeight,
      volumePerCssPixel,
    ),
  ).toBeCloseTo(2_800);

  expect(
    pressureVolumeAtY(
      center - rowHeight / 4,
      center,
      rowHeight,
      volumePerCssPixel,
    ),
  ).toBeCloseTo(2_800);

  expect(
    pressureVolumeAtY(
      center + rowHeight / 2,
      center,
      rowHeight,
      volumePerCssPixel,
    ),
  ).toBeNull();
});
