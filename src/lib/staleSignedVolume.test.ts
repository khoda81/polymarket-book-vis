import { describe, expect, test } from "bun:test";
import { HalfBook, type TokenBook } from "./orderBook";
import { StaleSignedVolume } from "./staleSignedVolume";

function makeBook(
  bids: readonly [price: number, yes: number][],
  asks: readonly [price: number, yes: number][],
): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  for (const [price, yes] of bids)
    usdToYes.setLevel(`b:${price}`, { price, take: yes });

  const yesToUsd = new HalfBook<string>();
  for (const [price, yes] of asks)
    yesToUsd.setLevel(`a:${price}`, {
      price: 1 / price,
      take: yes * price,
    });
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });

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

    expect(at(field, 1000, 0.3)).toMatchObject({ volume: 10, ageMs: 1000 });
    expect(at(field, 1000, 0.5)).toMatchObject({ volume: 0, ageMs: Infinity });
    expect(at(field, 1000, 0.7)).toMatchObject({ volume: -20, ageMs: 1000 });
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

    expect(at(field, 15_000, 0.2)).toMatchObject({
      volume: 17,
      ageMs: 5_000,
    });
    expect(at(field, 15_000, 0.35)).toMatchObject({
      volume: 10,
      ageMs: 15_000,
    });
    expect(at(field, 15_000, 0.7)).toMatchObject({
      volume: -20,
      ageMs: 15_000,
    });
  });

  test("removing the best bid freezes the disappeared pressure exactly at the event", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    field.update(
      makeBook([[0.4, 10]], [[0.6, 20]]),
      10_000,
      [{ lo: 0, hi: 0.45 }],
    );

    expect(at(field, 15_000, 0.3)).toMatchObject({
      volume: 10,
      ageMs: 5_000,
    });
    expect(at(field, 15_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 5_000,
    });
    expect(at(field, 15_000, 0.7)).toMatchObject({
      volume: -20,
      ageMs: 15_000,
    });
  });

  test("freshness becomes older monotonically as bid observations stop reaching inward", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    field.update(
      makeBook([[0.4, 10]], [[0.6, 20]]),
      10_000,
      [{ lo: 0, hi: 0.45 }],
    );
    field.update(
      makeBook([[0.42, 8]], [[0.6, 20]]),
      20_000,
      [{ lo: 0, hi: 0.42 }],
    );

    expect(at(field, 30_000, 0.3).ageMs).toBe(10_000);
    expect(at(field, 30_000, 0.41).ageMs).toBe(10_000);
    expect(at(field, 30_000, 0.43).ageMs).toBe(20_000);
  });

  test("full snapshots do not fabricate when an empty region became stale", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 0);

    // Imagine reconnecting after missing the cancellation event. The snapshot
    // proves current pressure outside the spread, but not when 0.425 emptied.
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    expect(at(field, 30_000, 0.3)).toMatchObject({
      volume: 10,
      ageMs: 10_000,
    });
    expect(at(field, 30_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 30_000,
    });
  });

  test("snapshot/restore preserves v3 observation timestamps and explicit unknowns", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    field.update(
      makeBook([[0.4, 10]], [[0.55, 7]]),
      20_000,
      [{ lo: 0, hi: 0.45 }],
    );

    const snapshot = field.snapshot();
    expect(snapshot.version).toBe(3);
    expect("spread" in snapshot).toBe(false);

    const restored = new StaleSignedVolume();
    restored.restore(snapshot);
    expect(at(restored, 35_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 15_000,
    });

    const initiallyUnknown = new StaleSignedVolume();
    initiallyUnknown.update(makeBook([[0.4, 10]], [[0.6, 20]]), 10_000);
    const restoredUnknown = new StaleSignedVolume();
    restoredUnknown.restore(initiallyUnknown.snapshot());
    expect(at(restoredUnknown, 35_000, 0.5).ageMs).toBe(Infinity);
  });

  test("restore still migrates legacy v2 timestamps", () => {
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

    expect(at(restored, 30_000, 0.2).ageMs).toBe(20_000);
    expect(at(restored, 30_000, 0.5).ageMs).toBe(Infinity);
    expect(at(restored, 30_000, 0.8).ageMs).toBe(10_000);
  });

  test("transport hydration rebases finite ages and preserves Infinity", () => {
    const source = new StaleSignedVolume();
    source.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    source.update(
      makeBook([[0.4, 10]], [[0.55, 7]]),
      20_000,
      [{ lo: 0, hi: 0.45 }],
    );

    const hydrated = new StaleSignedVolume();
    hydrated.restoreSegments(source.segments(35_000), 1_000);

    expect(at(hydrated, 2_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 16_000,
    });

    const unknownSource = new StaleSignedVolume();
    unknownSource.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    const unknownHydrated = new StaleSignedVolume();
    unknownHydrated.restoreSegments(unknownSource.segments(1_000), 5_000);
    expect(at(unknownHydrated, 6_000, 0.5).ageMs).toBe(Infinity);
  });
});
