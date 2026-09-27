import { expect, spyOn, test } from "bun:test";
import { emptyTokenBook } from "../lib/orderBook";
import { PressureFrontierMemory } from "../lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../lib/price";
import { AgeStripPressureState } from "./ageStripPressureState";

test("token pressure follows only that token's asks", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.65), 70);
  book.usdToYes.setLevel(p(0.6), 100);

  state.applyBookUpdate("token", book, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });

  expect(state.memory("token")!.currentLevels()).toEqual([
    { key: p(0.65), weight: 70 },
  ]);
});

test("invalid recorder data preserves current pressure and does not abort later tokens", () => {
  const state = new AgeStripPressureState();
  const currentBook = emptyTokenBook();
  currentBook.yesToUsd.setLevel(p(0.6), 40_380);
  state.applyBookUpdate("bad-token", currentBook, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });
  const before = state.memory("bad-token")!.snapshot();

  const recorded = new PressureFrontierMemory();
  recorded.updateLevels([{ price: p(0.6), shares: 100 }], 1_000);
  recorded.updateLevels([{ price: p(0.6), shares: 60 }], 2_000);
  const valid = recorded.snapshot();
  const invalid = { ...valid, current: [] };

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    state.hydrate({ "bad-token": invalid, "good-token": valid }, (token) =>
      token === "bad-token" ? currentBook : undefined,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bad-token");
  } finally {
    warn.mockRestore();
  }

  expect(state.memory("bad-token")!.snapshot()).toEqual(before);
  expect(state.memory("good-token")!.bandsAtPrice(p(0.7))).toEqual(
    recorded.bandsAtPrice(p(0.7)),
  );
});

test("late recorder hydration keeps websocket validity and older token history", () => {
  const state = new AgeStripPressureState();
  const currentBook = emptyTokenBook();
  currentBook.yesToUsd.setLevel(p(0.6), 40_380);
  state.applyBookUpdate("token", currentBook, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });

  const recorded = new PressureFrontierMemory();
  recorded.updateLevels([{ price: p(0.6), shares: 80_000 }], 1_000);

  state.hydrate({ token: recorded.snapshot() }, () => currentBook);

  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    {
      loVolume: 0,
      hiVolume: 40_380,
      validThroughMs: 3_000,
    },
    {
      loVolume: 40_380,
      hiVolume: 80_000,
      validThroughMs: 1_000,
    },
  ]);
});
