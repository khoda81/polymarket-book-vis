import { expect, test } from "bun:test";
import {
  agePressurePerspective,
  agePressureSideAtY,
  pressurePriceAtDisplayX,
  pressureVolumeAtY,
  tokenPriceAtDisplayX,
} from "./ageStripPressureProjection";
import { PRICE_SCALE } from "@/lib/price";

test("age pressure perspectives define token identity and projection together", () => {
  expect(agePressurePerspective("primary")).toMatchObject({
    mirrorPrice: true,
    yDirection: 1,
    colorSign: 1,
  });
  expect(agePressurePerspective("opposite")).toMatchObject({
    mirrorPrice: false,
    yDirection: -1,
    colorSign: -1,
  });

  expect(agePressureSideAtY(15, 14)).toBe("primary");
  expect(agePressureSideAtY(13, 14)).toBe("opposite");
});

test("screen x maps into each token's own price coordinate", () => {
  const primary = agePressurePerspective("primary");
  const opposite = agePressurePerspective("opposite");

  expect(tokenPriceAtDisplayX(0.25, primary)).toBe(0.75);
  expect(tokenPriceAtDisplayX(0.25, opposite)).toBe(0.25);
  expect(Number(pressurePriceAtDisplayX(0.25, primary))).toBe(
    Math.floor(0.75 * PRICE_SCALE),
  );
  expect(Number(pressurePriceAtDisplayX(0.25, opposite))).toBe(
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
