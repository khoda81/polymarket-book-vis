import { expect, test } from "bun:test";
import { rasterizeAgeRows } from "./ageStripLayout";
import { AGE_ROW_BAND_PX } from "./ageStripTuning";

test("snapped age boundaries partition device pixels at fractional DPR", () => {
  for (const rowCount of [1, 2, 3, 5, 9]) {
    const viewportTop = 29.3;
    const viewportHeight = rowCount * AGE_ROW_BAND_PX;
    const canvasHeight = viewportTop + viewportHeight + 16.7;

    for (const dpr of [1, 1.1, 1.25, 4 / 3, 1.5, 1.8, 2, 2.5, 3]) {
      const deviceHeight = Math.floor(canvasHeight * dpr);
      const scaleY = deviceHeight / canvasHeight;
      const rows = rasterizeAgeRows(
        viewportTop,
        viewportHeight,
        rowCount,
        canvasHeight,
        deviceHeight,
      );

      expect(rows).toHaveLength(rowCount);
      for (const [index, row] of rows.entries()) {
        const topDevice = Math.round(row.topCss * scaleY);
        const centerDevice = Math.round(row.centerCss * scaleY);
        const bottomDevice = Math.round(row.bottomCss * scaleY);

        // CSS coordinates round-trip to integer framebuffer coordinates.
        expect(row.topCss * scaleY).toBeCloseTo(topDevice, 10);
        expect(row.centerCss * scaleY).toBeCloseTo(centerDevice, 10);
        expect(row.bottomCss * scaleY).toBeCloseTo(bottomDevice, 10);

        // Both halves own disjoint, nonempty pixel intervals.
        expect(topDevice).toBeLessThan(centerDevice);
        expect(centerDevice).toBeLessThan(bottomDevice);
        expect(row.heightCss).toBeCloseTo(
          (bottomDevice - topDevice) / scaleY,
          10,
        );

        // Each boundary is nearest-neighbor snapped from the ideal grid.
        for (const [boundary, halfIndex] of [
          [topDevice, 2 * index],
          [centerDevice, 2 * index + 1],
          [bottomDevice, 2 * index + 2],
        ] as const) {
          const ideal =
            (viewportTop + (viewportHeight * halfIndex) / (2 * rowCount)) *
            scaleY;
          expect(boundary).toBe(Math.round(ideal));
        }

        // Neighboring rows share one edge, rather than rounding heights.
        if (index > 0) {
          const previous = rows[index - 1]!;
          expect(topDevice).toBe(Math.round(previous.bottomCss * scaleY));
        }

        // Snap error never accumulates, even after many half-rows.
        expect(Math.abs(row.heightCss - AGE_ROW_BAND_PX)).toBeLessThanOrEqual(
          1 / scaleY + 1e-9,
        );
      }
    }
  }
});

test("empty row sets have no raster geometry", () => {
  expect(rasterizeAgeRows(25, 0, 0, 50, 75)).toEqual([]);
});
