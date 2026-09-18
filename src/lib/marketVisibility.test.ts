import { expect, test } from "bun:test";
import {
  initialMarketVisibility,
  isMarketVisible,
} from "./marketVisibility";

test("market visibility encodes why a row is hidden", () => {
  expect(initialMarketVisibility(true, false)).toEqual({
    kind: "visible",
  });
  expect(initialMarketVisibility(false, false)).toEqual({
    kind: "hidden",
    reason: "not-accepting-orders",
  });
  expect(initialMarketVisibility(false, true)).toEqual({
    kind: "hidden",
    reason: "user",
  });
  expect(isMarketVisible({ kind: "visible" })).toBe(true);
  expect(
    isMarketVisible({ kind: "hidden", reason: "empty-book" }),
  ).toBe(false);
});
