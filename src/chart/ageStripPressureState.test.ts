import { expect, spyOn, test } from "bun:test";
import { emptyTokenBook } from "../lib/orderBook";
import { PressureFrontierMemory } from "../lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../lib/price";
import { AgeStripPressureState } from "./ageStripPressureState";

test("invalid recorder data preserves live rows and does not abort later tokens", () => {
  const state = new AgeStripPressureState();
  const liveBook = emptyTokenBook();
  liveBook.usdToYes.setLevel(p(0.6), 40_380);
  state.observeBook("bad-token", liveBook, 3_000);
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
      (token) => (token === "bad-token" ? liveBook : undefined),
      4_000,
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

test("late recorder hydration overlays the current book on recorded history", () => {
  const state = new AgeStripPressureState();
  const liveBook = emptyTokenBook();
  liveBook.usdToYes.setLevel(p(0.6), 40_380);
  state.observeBook("token", liveBook, 3_000);
  const recorded = new PressureFrontierMemory();
  recorded.updateLevels("bid", [{ price: p(0.6), shares: 80_000 }], 1_000);
  state.hydrate({ token: recorded.snapshot() }, () => liveBook, 4_000);
  expect(state.memory("token")!.shellsAtPrice(p(0.5))).toEqual([
    { loVolume: 0, hiVolume: 40_380, side: 1, state: { kind: "live" } },
    {
      loVolume: 40_380,
      hiVolume: 80_000,
      side: 1,
      state: { kind: "ghost", sinceMs: 4_000 },
    },
  ]);
});
