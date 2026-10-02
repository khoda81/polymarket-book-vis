import { expect, test } from "bun:test";
import { stalenessAlpha } from "../../domain/pressure/pressureField";
import {
  GHOST_ALPHA_BUCKET_WIDTH,
  ghostRefreshDelayMs,
} from "./ageStripTuning";

test("ghost refresh delay reaches the configured maximum alpha error", () => {
  const halfLifeMs = 5_000;
  const delayMs = ghostRefreshDelayMs(halfLifeMs);
  const alphaError = 1 - stalenessAlpha(0, delayMs, halfLifeMs);

  expect(alphaError).toBeCloseTo(GHOST_ALPHA_BUCKET_WIDTH, 12);
  expect(1 - stalenessAlpha(0, delayMs * 0.999, halfLifeMs)).toBeLessThan(
    GHOST_ALPHA_BUCKET_WIDTH,
  );
});
