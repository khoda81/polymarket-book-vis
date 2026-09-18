import { expect, test } from "bun:test";
import {
  initialMarketVisibility,
  isMarketVisible,
  partitionMarketVisibility,
  setUserMarketVisible,
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


test("visibility partition reacts to a replaced visibility map", () => {
  const markets = [
    { marketId: "a" },
    { marketId: "b" },
    { marketId: "c" },
  ];

  const first = partitionMarketVisibility(
    markets,
    new Map([
      ["b", { kind: "hidden", reason: "empty-book" }],
    ]),
  );
  expect(first.visible.map((market) => market.marketId)).toEqual([
    "a",
    "c",
  ]);
  expect(first.hidden.map((market) => market.marketId)).toEqual(["b"]);

  const second = partitionMarketVisibility(
    markets,
    new Map([
      ["a", { kind: "hidden", reason: "resolved" }],
      ["c", { kind: "hidden", reason: "user" }],
    ]),
  );
  expect(second.visible.map((market) => market.marketId)).toEqual(["b"]);
  expect(second.hidden.map((market) => market.marketId)).toEqual([
    "a",
    "c",
  ]);
});


test("user visibility update replaces state without a second source of truth", () => {
  const initial = new Map<string, import("./marketVisibility").MarketVisibility>([
    ["a", { kind: "visible" }],
    ["b", { kind: "hidden", reason: "empty-book" }],
  ]);

  const hidden = setUserMarketVisible(initial, "a", false);
  expect(initial.get("a")).toEqual({ kind: "visible" });
  expect(hidden.get("a")).toEqual({
    kind: "hidden",
    reason: "user",
  });

  const visible = setUserMarketVisible(hidden, "a", true);
  expect(visible.get("a")).toEqual({ kind: "visible" });
  expect(visible.get("b")).toEqual({
    kind: "hidden",
    reason: "empty-book",
  });
});
