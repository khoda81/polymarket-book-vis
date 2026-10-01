import { expect, test } from "bun:test";
import {
  ageStripRowAtY,
  ageStripRowCenterY,
  type AgeStripGeometry,
} from "./ageStripLayout";

test("age row hit testing uses explicit moving row geometry", () => {
  const geometry: AgeStripGeometry = {
    viewport: { l: 60, t: 0, width: 300, height: 140 },
    rows: [
      {
        tokenId: "past",
        centerY: 18,
        topY: 4,
        bottomY: 32,
      },
      {
        tokenId: "live",
        centerY: 46,
        topY: 32,
        bottomY: 60,
      },
    ],
    canvasWidth: 420,
    canvasHeight: 140,
  };

  expect(ageStripRowAtY(geometry, 10)?.tokenId).toBe("past");
  expect(ageStripRowAtY(geometry, 45)?.tokenId).toBe("live");
  expect(ageStripRowAtY(geometry, 80)).toBeNull();
  expect(ageStripRowCenterY(geometry, geometry.rows[1]!)).toBe(46);
});

test("age row hit testing preserves uniform event geometry", () => {
  const geometry: AgeStripGeometry = {
    viewport: { l: 60, t: 10, width: 300, height: 84 },
    rows: [{ tokenId: "a" }, { tokenId: "b" }, { tokenId: "c" }],
    canvasWidth: 420,
    canvasHeight: 100,
  };

  expect(ageStripRowAtY(geometry, 12)?.tokenId).toBe("a");
  expect(ageStripRowAtY(geometry, 50)?.tokenId).toBe("b");
  expect(ageStripRowAtY(geometry, 90)?.tokenId).toBe("c");
});
