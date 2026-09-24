import { expect, test } from "bun:test";
import type { MarketId } from "@polymarket/client";
import {
  initialMarketVisibility,
  isMarketVisible,
  mergeUserHiddenMarketIds,
  partitionMarketVisibility,
  setUserMarketVisible,
} from "./marketVisibility";

const marketId = (value: string): MarketId => value as MarketId;

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
  const markets = [
    { market: { id: marketId("a") } },
    { market: { id: marketId("b") } },
    { market: { id: marketId("c") } },
  ];

  const first = partitionMarketVisibility(
    markets,
    new Map([[marketId("b"), { kind: "hidden", reason: "empty-book" }]]),
  );
  expect(first.visible.map((market) => market.market.id)).toEqual([marketId("a"), marketId("c")]);
  expect(first.hidden.map((market) => market.market.id)).toEqual([marketId("b")]);

  const second = partitionMarketVisibility(
    markets,
    new Map([
      [marketId("a"), { kind: "hidden", reason: "empty-book" }],
      [marketId("c"), { kind: "hidden", reason: "user" }],
    ]),
  );
  expect(second.visible.map((market) => market.market.id)).toEqual([marketId("b")]);
  expect(second.hidden.map((market) => market.market.id)).toEqual([marketId("a"), marketId("c")]);
});

test("user visibility update replaces state without a second source of truth", () => {
  const initial = new Map<
    MarketId,
    import("./marketVisibility").MarketVisibility
  >([
    [marketId("a"), { kind: "visible" }],
    [marketId("b"), { kind: "hidden", reason: "empty-book" }],
  ]);

  const hidden = setUserMarketVisible(initial, marketId("a"), false);
  expect(initial.get(marketId("a"))).toEqual({ kind: "visible" });
  expect(hidden.get(marketId("a"))).toEqual({
    kind: "hidden",
    reason: "user",
  });

  const visible = setUserMarketVisible(hidden, marketId("a"), true);
  expect(visible.get(marketId("a"))).toEqual({ kind: "visible" });
  expect(visible.get(marketId("b"))).toEqual({
    kind: "hidden",
    reason: "empty-book",
  });
});

test("persisting one event preserves user-hidden markets from other events", () => {
  const persisted = new Set(["country-fr", "country-de", "other-event-market"]);
  const currentEvent = new Map<
    MarketId,
    import("./marketVisibility").MarketVisibility
  >([
    [marketId("country-fr"), { kind: "hidden", reason: "user" }],
    [marketId("country-de"), { kind: "visible" }],
    [marketId("country-jp"), { kind: "hidden", reason: "user" }],
  ]);

  expect([...mergeUserHiddenMarketIds(persisted, currentEvent)].sort()).toEqual(
    ["country-fr", "country-jp", "other-event-market"].sort(),
  );
});
