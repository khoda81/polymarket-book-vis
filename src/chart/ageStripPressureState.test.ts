import { expect, spyOn, test } from "bun:test";
import { emptyTokenBook } from "../lib/orderBook";
import { PressureFrontierMemory } from "../lib/pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "../lib/price";
import { AgeStripPressureState } from "./ageStripPressureState";

test("CLOB asks map to primary edge and bids to complemented opposite edge", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.65), 70);
  book.usdToYes.setLevel(p(0.6), 100);

  state.applyBookUpdate("token", book, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });

  const memory = state.memory("token")!;
  expect(memory.currentLevels("primaryToCollateral")).toEqual([
    { key: p(0.65), weight: 70 },
  ]);
  expect(memory.currentLevels("oppositeToCollateral")).toEqual([
    { key: p(0.4), weight: 100 },
  ]);
});

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
  recorded.updateEdges([], [{ price: p(0.4), shares: 100 }], 1_000);
  recorded.updateEdges([], [{ price: p(0.4), shares: 60 }], 2_000);
  const valid = recorded.snapshot();
  const invalid = {
    ...valid,
    oppositeToCollateral: {
      ...valid.oppositeToCollateral,
      current: [],
    },
  };

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
  expect(
    state.memory("good-token")!.bandsAtPrice("oppositeToCollateral", p(0.5)),
  ).toEqual(recorded.bandsAtPrice("oppositeToCollateral", p(0.5)));
});

test("late recorder hydration keeps websocket validity and older edge history", () => {
  const state = new AgeStripPressureState();
  const currentBook = emptyTokenBook();
  currentBook.usdToYes.setLevel(p(0.6), 40_380);
  state.applyBookUpdate("token", currentBook, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });

  const recorded = new PressureFrontierMemory();
  recorded.updateEdges([], [{ price: p(0.4), shares: 80_000 }], 1_000);

  state.hydrate({ token: recorded.snapshot() }, () => currentBook);

  expect(
    state.memory("token")!.bandsAtPrice("oppositeToCollateral", p(0.5)),
  ).toEqual([
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
