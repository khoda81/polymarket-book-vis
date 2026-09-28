import { expect, spyOn, test } from "bun:test";
import { emptyTokenBook } from "../lib/orderBook";
import { FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT } from "../lib/pressureField";
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
    { price: p(0.65), shares: 70 },
  ]);
});

test("opposite-side book updates advance token pressure validity", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.65), 70);

  state.applyBookUpdate("token", book, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });

  book.usdToYes.setLevel(p(0.6), 100);
  state.applyBookUpdate("token", book, {
    kind: "levels",
    validThroughMs: 2_500,
    changes: [{ side: "bid", price: p(0.6), shares: 100 }],
  });

  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    { loVolume: 0, hiVolume: 70, validThroughMs: 2_500 },
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

test("runtime extents compose over pressure history without erasing it", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  const before = state.memory("token")!.snapshot();

  state.setExtents("token", [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);

  expect(state.bandAtPoint("token", p(0.7), 1_000_000)).toEqual({
    loVolume: 0,
    hiVolume: { kind: "unbounded" },
    validity: { kind: "persistent" },
  });
  expect(state.memory("token")!.snapshot()).toEqual(before);
  expect(state.hasVisiblePressure("token", 1_000_000_000, 1_000)).toBe(true);
});

test("removing a runtime extent reveals the historical field again", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.setExtents("token", [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);
  state.setExtents("token", []);

  expect(state.bandAtPoint("token", p(0.7), 20)).toEqual({
    loVolume: 0,
    hiVolume: { kind: "finite", shares: 40 },
    validity: { kind: "through", validThroughMs: 1_000 },
  });
});
