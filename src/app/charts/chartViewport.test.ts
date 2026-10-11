import { expect, test } from "bun:test";
import { chartWindow } from "./chartViewport";
import { AGE_ROW_BAND_PX } from "../../chart/age/ageStripTuning";

test("large groups render a bounded window and keep original row indices", () => {
  const first = chartWindow(10_000, 0, 320_048, 0, 384);
  expect(first.start).toBe(0);
  expect(first.end).toBeLessThan(16);
  const middle = chartWindow(
    10_000,
    -5_000 * AGE_ROW_BAND_PX,
    5_000 * AGE_ROW_BAND_PX + 48,
    0,
    384,
  );
  expect(middle.start).toBeGreaterThan(4_990);
  expect(middle.end - middle.start).toBeLessThan(18);
  expect(chartWindow(100, 400, 3_648, 0, 384)).toEqual({ start: 0, end: 0 });
  expect(chartWindow(100, -3_648, -400, 0, 384)).toEqual({ start: 0, end: 0 });
  expect(chartWindow(100, -100, 3_148, 500, 384)).toEqual({ start: 0, end: 0 });
});
