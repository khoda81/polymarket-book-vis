import { expect, test } from "bun:test";
import { shareLegendLayout } from "./shareLegendLayout";

test("phone pressure bars keep visible signed ticks and readable nonoverlapping labels", () => {
  for (const width of [120, 140, 160, 170, 220, 430]) {
    for (const reserve of [0.01, 11_600, 320_000, 1_300_000]) {
      for (const dpr of [1, 1.25, 2, 3]) {
        const { ticks, labels } = shareLegendLayout(reserve, width, dpr);
        expect(
          ticks.some((tick) => tick.value < 0 && tick.opacity >= 0.5),
        ).toBe(true);
        expect(
          ticks.some((tick) => tick.value > 0 && tick.opacity >= 0.5),
        ).toBe(true);
        expect(labels.some((tick) => tick.value < 0)).toBe(true);
        expect(labels.some((tick) => tick.value > 0)).toBe(true);
        expect(labels.some((tick) => tick.value === 0)).toBe(true);
        let previousRight = -6;
        for (const label of labels) {
          const halfWidth = label.label.length * 3;
          const left = label.position * width - halfWidth;
          const right = label.position * width + halfWidth;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(right).toBeLessThanOrEqual(width);
          expect(left - previousRight).toBeGreaterThanOrEqual(6 - 1e-9);
          previousRight = right;
        }
      }
    }
  }
});
