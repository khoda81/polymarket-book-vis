import { expect, spyOn, test } from "bun:test";
import { NO_FEE_SCHEDULE } from "../lib/feeSchedule";
import { observationTime } from "../lib/observationClock";
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

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
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

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });

  book.usdToYes.setLevel(p(0.6), 100);
  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
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
  state.applyBookUpdate("bad-token", currentBook, NO_FEE_SCHEDULE, {
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
    state.hydrate(
      { "bad-token": invalid, "good-token": valid },
      (token) => (token === "bad-token" ? currentBook : undefined),
      () => NO_FEE_SCHEDULE,
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
  state.applyBookUpdate("token", currentBook, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 3_000,
  });

  const recorded = new PressureFrontierMemory();
  recorded.updateLevels([{ price: p(0.6), shares: 80_000 }], 1_000);

  state.hydrate(
    { token: recorded.snapshot() },
    () => currentBook,
    () => NO_FEE_SCHEDULE,
  );

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

test("recorder-ahead hydration waits for websocket catch-up then rebases from the full live book", () => {
  const state = new AgeStripPressureState();
  const liveBook = emptyTokenBook();
  liveBook.yesToUsd.setLevel(p(0.6), 40);
  state.applyBookUpdate("token", liveBook, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 3_600,
  });

  const recorded = new PressureFrontierMemory();
  recorded.observeLevels([{ price: p(0.6), shares: 80 }], 3_666);
  state.hydrate(
    { token: recorded.snapshot() },
    () => liveBook,
    () => NO_FEE_SCHEDULE,
  );

  // The local stream is still behind recorder history. Its raw book changes,
  // but pressure must not move backward or incrementally mutate the newer
  // recorder frontier.
  liveBook.yesToUsd.setLevel(p(0.6), 60);
  expect(() =>
    state.applyBookUpdate("token", liveBook, NO_FEE_SCHEDULE, {
      kind: "levels",
      validThroughMs: 3_663,
      changes: [{ side: "ask", price: p(0.6), shares: 60 }],
    }),
  ).not.toThrow();
  expect(state.memory("token")!.currentLevels()).toEqual([
    { price: p(0.6), shares: 80 },
  ]);

  // Once live evidence catches up, rebase from the complete current book so
  // any deltas skipped behind the barrier are incorporated in one observation.
  liveBook.yesToUsd.setLevel(p(0.6), 50);
  state.applyBookUpdate("token", liveBook, NO_FEE_SCHEDULE, {
    kind: "watermark",
    validThroughMs: 3_667,
  });

  expect(state.memory("token")!.currentLevels()).toEqual([
    { price: p(0.6), shares: 50 },
  ]);
  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    { loVolume: 0, hiVolume: 50, validThroughMs: 3_667 },
    { loVolume: 50, hiVolume: 80, validThroughMs: 3_666 },
  ]);
});

test("runtime extents compose over pressure history without erasing it", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
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
  expect(state.renderExtents("token")[0]!.validity).toEqual({
    kind: "persistent",
  });
});

test("removing a runtime extent reveals the historical field again", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
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

test("market watermark advances unchanged token pressure", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.65), 70);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "watermark",
    validThroughMs: 2_500,
  });

  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    { loVolume: 0, hiVolume: 70, validThroughMs: 2_500 },
  ]);
});

test("unbounded terminal pressure discards dominated finite history", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.resolveSource("token", true, 2_000);

  expect(state.memory("token")!.isResolvedUnbounded()).toBe(true);
  expect(state.memory("token")!.snapshot()).toEqual({
    version: 7,
    state: { kind: "resolvedUnbounded" },
  });
  expect(state.bandAtPoint("token", p(0.7), 1_000_000)).toEqual({
    loVolume: 0,
    hiVolume: { kind: "unbounded" },
    validity: { kind: "persistent" },
  });
});

test("unknown resolution time never extends loser history", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.resolveSource("token", false, null);

  expect(state.memory("token")!.currentLevels()).toEqual([]);
  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    { loVolume: 0, hiVolume: 40, validThroughMs: 1_000 },
  ]);
});

test("observed resolution time freezes loser history through resolution", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);

  state.applyBookUpdate("token", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.resolveSource("token", false, 2_000);

  expect(state.memory("token")!.currentLevels()).toEqual([]);
  expect(state.memory("token")!.bandsAtPrice(p(0.7))).toEqual([
    { loVolume: 0, hiVolume: 40, validThroughMs: 2_000 },
  ]);
});

test("recorder coverage remains token-local when starts differ or one token is missing", () => {
  const state = new AgeStripPressureState();
  state.configure([
    { tokenId: "yes", resolutionMs: 10_000 },
    { tokenId: "no", resolutionMs: 10_000 },
  ]);
  state.setRecordingCoverage({ no: 2_000 });
  expect(state.timing("yes")!.recordingSinceMs).toBeNull();
  expect(state.timing("no")!.recordingSinceMs).toBe(2_000);
  state.setRecordingCoverage({ yes: 1_000 });
  expect(state.timing("yes")!.recordingSinceMs).toBe(1_000);
  expect(state.timing("no")!.recordingSinceMs).toBe(2_000);
});

test("frontier observation time stays token-local, including hydration", () => {
  const state = new AgeStripPressureState();
  const book = emptyTokenBook();
  book.yesToUsd.setLevel(p(0.6), 40);
  expect(state.observationTime("first")).toBeUndefined();

  state.applyBookUpdate("first", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 1_000,
  });
  state.applyBookUpdate("second", book, NO_FEE_SCHEDULE, {
    kind: "snapshot",
    validThroughMs: 2_000,
  });
  expect(state.observationTime("first")).toBe(observationTime(1_000));
  expect(state.observationTime("second")).toBe(observationTime(2_000));

  const history = new PressureFrontierMemory();
  history.observeLevels([{ price: p(0.5), shares: 20 }], 3_000);
  state.hydrate(
    { first: history.snapshot() },
    () => undefined,
    () => NO_FEE_SCHEDULE,
  );
  expect(state.observationTime("first")).toBe(observationTime(3_000));

  state.retain(new Set(["second"]));
  expect(state.observationTime("first")).toBeUndefined();
  expect(state.observationTime("second")).toBe(observationTime(2_000));
});
