import { expect, test } from "bun:test";
import type { MarketId } from "@polymarket/client";
import {
  initialMarketVisibility,
  isMarketVisible,
  loadStoredMarketVisibility,
  partitionMarketVisibility,
  persistStoredMarketVisibility,
} from "./marketVisibility";

import { MarketState } from "./marketState";

const marketId = (value: string): MarketId => value as MarketId;

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  seed(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("market visibility encodes stored overrides before lifecycle defaults", () => {
  expect(initialMarketVisibility(undefined, { kind: "live" })).toEqual({
    kind: "visible",
  });
  expect(initialMarketVisibility("hidden-user", { kind: "live" })).toEqual({
    kind: "hidden",
    reason: "user",
  });
  expect(initialMarketVisibility("hidden-empty", { kind: "live" })).toEqual({
    kind: "hidden",
    reason: "empty-book",
  });
  expect(
    initialMarketVisibility(undefined, {
      kind: "resolved",
      winningTokenId: "winner" as never,
      winningOutcome: "Yes",
    }),
  ).toEqual({
    kind: "hidden",
    reason: "resolved-default",
  });
  expect(
    initialMarketVisibility("visible-user", {
      kind: "resolved",
      winningTokenId: "winner" as never,
      winningOutcome: "Yes",
    }),
  ).toEqual({ kind: "visible" });
  expect(isMarketVisible({ kind: "visible" })).toBe(true);
  expect(isMarketVisible({ kind: "hidden", reason: "empty-book" })).toBe(false);
});

test("visibility partition preserves the card order supplied by its caller", () => {
  const markets = [
    { market: { id: marketId("c") } },
    { market: { id: marketId("a") } },
    { market: { id: marketId("b") } },
  ];

  const partition = partitionMarketVisibility(
    markets,
    new Map([
      [marketId("a"), { kind: "hidden", reason: "user" }],
      [marketId("b"), { kind: "hidden", reason: "resolved-default" }],
    ]),
  );

  expect(partition.visible.map((market) => market.market.id)).toEqual([
    marketId("c"),
  ]);
  expect(partition.hidden.map((market) => market.market.id)).toEqual([
    marketId("a"),
    marketId("b"),
  ]);
});

test("resolved auto-hide survives reload even before resolution metadata catches up", () => {
  const storage = new MemoryStorage();
  persistStoredMarketVisibility("market-a", "hidden-resolved", storage);

  const state = new MarketState(storage);
  state.reconcile(marketId("market-a"), { kind: "live" });
  expect(state.visibilityFor(marketId("market-a"))).toEqual({
    kind: "hidden",
    reason: "resolved-default",
  });
});

test("empty-book auto-hide survives reload by market id", () => {
  const storage = new MemoryStorage();
  persistStoredMarketVisibility("market-a", "hidden-empty", storage);

  const state = new MarketState(storage);
  state.reconcile(marketId("market-a"), { kind: "live" });
  expect(state.visibilityFor(marketId("market-a"))).toEqual({
    kind: "hidden",
    reason: "empty-book",
  });
});

test("explicitly showing a resolved market survives reload", () => {
  const storage = new MemoryStorage();
  persistStoredMarketVisibility("market-a", "visible-user", storage);

  const state = new MarketState(storage);
  state.reconcile(marketId("market-a"), {
    kind: "resolved",
    winningTokenId: "winner" as never,
    winningOutcome: "Yes",
  });
  expect(state.visibilityFor(marketId("market-a"))).toEqual({
    kind: "visible",
  });
});

test("explicit showing is persisted for live and closed markets", () => {
  expect(
    initialMarketVisibility(undefined, { kind: "awaiting-resolution" }),
  ).toEqual({ kind: "hidden", reason: "closed-default" });
  expect(
    initialMarketVisibility("visible-user", { kind: "awaiting-resolution" }),
  ).toEqual({ kind: "visible" });
});

test("v2 visibility storage preserves legacy user-hidden markets", () => {
  const storage = new MemoryStorage();
  storage.seed(
    "polymarket-book-vis.age-strip-hidden-markets.v1",
    JSON.stringify(["legacy-hidden"]),
  );
  persistStoredMarketVisibility("resolved-hidden", "hidden-resolved", storage);

  expect(Object.fromEntries(loadStoredMarketVisibility(storage))).toEqual({
    "legacy-hidden": "hidden-user",
    "resolved-hidden": "hidden-resolved",
  });
});
