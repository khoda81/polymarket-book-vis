import { describe, expect, test } from "bun:test";
import { HalfBook, emptyTokenBook, type TokenBook } from "./orderBook";
import { priceFromLegacyNumber as p } from "./price";
import { StaleSignedVolume } from "./staleSignedVolume";

function makeBook(
  bids: readonly [price: number, yes: number][],
  asks: readonly [price: number, yes: number][],
): TokenBook {
  const usdToYes = new HalfBook();
  for (const [price, yes] of bids) usdToYes.setLevel(p(price), yes);

  const yesToUsd = new HalfBook();
  for (const [price, yes] of asks) yesToUsd.setLevel(p(price), yes);

  return { usdToYes, yesToUsd };
}

function at(field: StaleSignedVolume, nowMs: number, price: number) {
  return field
    .segments(nowMs)
    .find((segment) => price >= segment.lo && price < segment.hi)!;
}

describe("StaleSignedVolume", () => {
  test("first snapshot timestamps present pressure and leaves the empty middle unknown", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);

    expect(at(field, 1000, 0.3)).toMatchObject({
      volume: 10,
      sweepCost: 6,
      ageMs: 1000,
    });
    expect(at(field, 1000, 0.5)).toMatchObject({
      volume: 0,
      sweepCost: null,
      ageMs: Infinity,
    });
    expect(at(field, 1000, 0.7)).toMatchObject({
      volume: -20,
      sweepCost: 12,
      ageMs: 1000,
    });
  });

  test("a bid update refreshes its whole cumulative prefix but not better prices or asks", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);

    field.update(
      makeBook(
        [
          [0.4, 10],
          [0.3, 7],
        ],
        [[0.6, 20]],
      ),
      10_000,
      [{ lo: 0, hi: 0.3 }],
    );

    const cumulative = at(field, 15_000, 0.2);
    expect(cumulative).toMatchObject({ volume: 17, ageMs: 5_000 });
    expect(cumulative.sweepCost).toBeCloseTo(10.9);
    expect(at(field, 15_000, 0.35)).toMatchObject({
      volume: 10,
      sweepCost: 6,
      ageMs: 15_000,
    });
    expect(at(field, 15_000, 0.7)).toMatchObject({
      volume: -20,
      sweepCost: 12,
      ageMs: 15_000,
    });
  });

  test("removing the best bid freezes its shares and sweep cost exactly at the event", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 10_000, [
      { lo: 0, hi: 0.45 },
    ]);

    expect(at(field, 15_000, 0.3)).toMatchObject({
      volume: 10,
      sweepCost: 6,
      ageMs: 5_000,
    });
    const stale = at(field, 15_000, 0.425);
    expect(stale).toMatchObject({ volume: 12, ageMs: 5_000 });
    expect(stale.sweepCost).toBeCloseTo(6.6);
    expect(at(field, 15_000, 0.7)).toMatchObject({
      volume: -20,
      sweepCost: 12,
      ageMs: 15_000,
    });
  });

  test("freshness becomes older monotonically as bid observations stop reaching inward", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 10_000, [
      { lo: 0, hi: 0.45 },
    ]);
    field.update(makeBook([[0.42, 8]], [[0.6, 20]]), 20_000, [
      { lo: 0, hi: 0.42 },
    ]);

    expect(at(field, 30_000, 0.3).ageMs).toBe(10_000);
    expect(at(field, 30_000, 0.41).ageMs).toBe(10_000);
    expect(at(field, 30_000, 0.43).ageMs).toBe(20_000);
  });

  test("full snapshots do not fabricate when an empty region became stale", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    expect(at(field, 30_000, 0.3)).toMatchObject({
      volume: 10,
      ageMs: 10_000,
    });
    const stale = at(field, 30_000, 0.425);
    expect(stale).toMatchObject({ volume: 12, ageMs: 30_000 });
    expect(stale.sweepCost).toBeCloseTo(6.6);
  });

  test("snapshot/restore preserves v4 economic samples and explicit unknowns", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    field.update(makeBook([[0.4, 10]], [[0.55, 7]]), 20_000, [
      { lo: 0, hi: 0.45 },
    ]);

    const snapshot = field.snapshot();
    expect(snapshot.version).toBe(4);
    expect("spread" in snapshot).toBe(false);

    const restored = new StaleSignedVolume();
    restored.restore(snapshot);
    const stale = at(restored, 35_000, 0.425);
    expect(stale).toMatchObject({ volume: 12, ageMs: 15_000 });
    expect(stale.sweepCost).toBeCloseTo(6.6);

    const initiallyUnknown = new StaleSignedVolume();
    initiallyUnknown.update(makeBook([[0.4, 10]], [[0.6, 20]]), 10_000);
    const restoredUnknown = new StaleSignedVolume();
    restoredUnknown.restore(initiallyUnknown.snapshot());
    expect(at(restoredUnknown, 35_000, 0.5)).toMatchObject({
      sweepCost: null,
      ageMs: Infinity,
    });
  });

  test("restore still migrates legacy v2 timestamps with unknown sweep cost", () => {
    const restored = new StaleSignedVolume();
    restored.restore({
      version: 2,
      lastUpdateMs: 20_000,
      segments: [
        { lo: 0, hi: 0.4, volume: 10, staleSinceMs: 10_000 },
        { lo: 0.4, hi: 0.6, volume: 0, staleSinceMs: null },
        { lo: 0.6, hi: 1, volume: -20, staleSinceMs: 20_000 },
      ],
    });

    expect(at(restored, 30_000, 0.2)).toMatchObject({
      ageMs: 20_000,
      sweepCost: null,
    });
    expect(at(restored, 30_000, 0.5)).toMatchObject({
      ageMs: Infinity,
      sweepCost: null,
    });
    expect(at(restored, 30_000, 0.8)).toMatchObject({
      ageMs: 10_000,
      sweepCost: null,
    });
  });

  test("transport hydration rebases finite ages and preserves sweep cost", () => {
    const source = new StaleSignedVolume();
    source.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    source.update(makeBook([[0.4, 10]], [[0.55, 7]]), 20_000, [
      { lo: 0, hi: 0.45 },
    ]);

    const hydrated = new StaleSignedVolume();
    hydrated.restoreSegments(source.segments(35_000), 1_000);

    const stale = at(hydrated, 2_000, 0.425);
    expect(stale).toMatchObject({ volume: 12, ageMs: 16_000 });
    expect(stale.sweepCost).toBeCloseTo(6.6);

    const unknownSource = new StaleSignedVolume();
    unknownSource.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    const unknownHydrated = new StaleSignedVolume();
    unknownHydrated.restoreSegments(source.segments(35_000), 1_000);
    unknownHydrated.restoreSegments(unknownSource.segments(1_000), 5_000);
    expect(at(unknownHydrated, 6_000, 0.5).ageMs).toBe(Infinity);
  });
});

test("repeated empty observations do not refresh stale liquidity", () => {
  const book = emptyTokenBook();
  book.usdToYes.setLevel(p(0.4), 10);

  const memory = new StaleSignedVolume();
  memory.update(book, 0);

  book.usdToYes.setLevel(p(0.4), 0);
  memory.update(book, 1_000, [{ lo: 0, hi: 0.4 }]);
  const firstStale = memory
    .segments(1_000)
    .find((segment) => segment.lo === 0 && segment.hi === 0.4);
  expect(firstStale?.ageMs).toBe(0);

  memory.update(book, 2_000, [{ lo: 0, hi: 0.4 }]);
  const stillStale = memory
    .segments(2_000)
    .find((segment) => segment.lo === 0 && segment.hi === 0.4);
  expect(stillStale?.ageMs).toBe(1_000);
});

test("restore rejects overlapping snapshots without mutating current state", () => {
  const memory = new StaleSignedVolume();
  const live = makeBook([[0.4, 10]], [[0.6, 10]]);
  memory.update(live, 100);
  const before = memory.snapshot();

  expect(() =>
    memory.restore({
      version: 4,
      lastUpdateMs: 200,
      segments: [
        {
          lo: 0,
          hi: 0.6,
          volume: 1,
          sweepCost: 1,
          observedAtMs: 100,
        },
        {
          lo: 0.5,
          hi: 1,
          volume: -1,
          sweepCost: 1,
          observedAtMs: 100,
        },
      ],
    }),
  ).toThrow(/overlap/i);

  expect(memory.snapshot()).toEqual(before);
});
