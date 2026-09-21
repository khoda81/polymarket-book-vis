import { expect, test } from "bun:test";
import {
  initialMarketVisibility,
  isMarketVisible,
  partitionMarketVisibility,
  setUserMarketVisible,
} from "./marketVisibility";

test("market visibility encodes why a row is hidden", () => {
  expect(initialMarketVisibility(false, { kind: "live" })).toEqual({
    kind: "visible",
  });
  expect(initialMarketVisibility(true, { kind: "live" })).toEqual({
    kind: "hidden",
    reason: "user",
  });
  expect(
    initialMarketVisibility(false, {
      kind: "resolved",
      winningTokenId: "winner" as never,
      winningOutcome: "Yes",
    }),
  ).toEqual({
    kind: "hidden",
    reason: "resolved-default",
  });
  expect(isMarketVisible({ kind: "visible" })).toBe(true);
  expect(isMarketVisible({ kind: "hidden", reason: "empty-book" })).toBe(false);
});

test("visibility partition reacts to a replaced visibility map", () => {
  const markets = [{ marketId: "a" }, { marketId: "b" }, { marketId: "c" }];

  const first = partitionMarketVisibility(
    markets,
    new Map([["b", { kind: "hidden", reason: "empty-book" }]]),
  );
  expect(first.visible.map((market) => market.marketId)).toEqual(["a", "c"]);
  expect(first.hidden.map((market) => market.marketId)).toEqual(["b"]);

  const second = partitionMarketVisibility(
    markets,
    new Map([
      ["a", { kind: "hidden", reason: "empty-book" }],
      ["c", { kind: "hidden", reason: "user" }],
    ]),
  );
  expect(second.visible.map((market) => market.marketId)).toEqual(["b"]);
  expect(second.hidden.map((market) => market.marketId)).toEqual(["a", "c"]);
});

test("user visibility update replaces state without a second source of truth", () => {
  const initial = new Map<
    string,
    import("./marketVisibility").MarketVisibility
  >([
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
