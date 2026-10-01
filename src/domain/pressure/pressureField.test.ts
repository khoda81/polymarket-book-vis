import { expect, test } from "bun:test";
import { stalenessAgeForOpacityErrorMs, stalenessAlpha } from "./pressureField";

test("opacity error budget derives an uncapped freshness age", () => {
  const halfLifeMs = 5_000;
  const maxOpacityError = 1 / 255;
  const ageMs = stalenessAgeForOpacityErrorMs(halfLifeMs, maxOpacityError);

  expect(ageMs).toBeGreaterThan(0);
  expect(ageMs).toBeLessThan(halfLifeMs);
  expect(1 - stalenessAlpha(0, ageMs, halfLifeMs)).toBeCloseTo(
    maxOpacityError,
    12,
  );

  expect(
    stalenessAgeForOpacityErrorMs(halfLifeMs * 1_000_000, maxOpacityError),
  ).toBeCloseTo(ageMs * 1_000_000, 6);
});
