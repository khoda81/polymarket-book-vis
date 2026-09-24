import { expect, spyOn, test } from "bun:test";
import { emptyTokenBook } from "../lib/orderBook";
import { PressureFrontierMemory } from "../lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../lib/price";
import { AgeStripPressureState } from "./ageStripPressureState";

test("invalid recorder data preserves current rows and does not abort later tokens", () => {
  const state = new AgeStripPressureState();
  const currentBook = emptyTokenBook();
  currentBook.usdToYes.setLevel(p(0.6), 40_380);
  state.applyBookUpdate("bad-token", currentBook, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });
  const before = state.memory("bad-token")!.snapshot();

  const recorded = new PressureFrontierMemory();
  recorded.updateLevels("bid", [{ price: p(0.6), shares: 100 }], 1_000);
  recorded.updateLevels("bid", [{ price: p(0.6), shares: 60 }], 2_000);
  const valid = recorded.snapshot();
  const invalid = { ...valid, bid: { current: [] } };

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    state.hydrate(
      { "bad-token": invalid, "good-token": valid },
      (token) => (token === "bad-token" ? currentBook : undefined),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bad-token");
  } finally {
    warn.mockRestore();
  }

  expect(state.memory("bad-token")!.snapshot()).toEqual(before);
  expect(state.memory("good-token")!.shellsAtPrice(p(0.5))).toEqual(
    recorded.shellsAtPrice(p(0.5)),
  );
});

test("late recorder hydration keeps websocket validity and older history", () => {
  const state = new AgeStripPressureState();
  const currentBook = emptyTokenBook();
  currentBook.usdToYes.setLevel(p(0.6), 40_380);
  state.applyBookUpdate("token", currentBook, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });

  const recorded = new PressureFrontierMemory();
  recorded.updateLevels("bid", [{ price: p(0.6), shares: 80_000 }], 1_000);

  state.hydrate({ token: recorded.snapshot() }, () => currentBook);

  expect(state.memory("token")!.shellsAtPrice(p(0.5))).toEqual([
    {
      loVolume: 0,
      hiVolume: 40_380,
      side: 1,
      validThroughMs: 3_000,
    },
    {
      loVolume: 40_380,
      hiVolume: 80_000,
      side: 1,
      validThroughMs: 1_000,
    },
  ]);
});
