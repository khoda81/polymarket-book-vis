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
  test("first snapshot timestamps observed pressure and leaves its spread unknown", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);

    expect(at(field, 1000, 0.3)).toMatchObject({ volume: 10, ageMs: 1000 });
    expect(at(field, 1000, 0.5)).toMatchObject({ volume: 0, ageMs: Infinity });
    expect(at(field, 1000, 0.7)).toMatchObject({ volume: -20, ageMs: 1000 });
  });

  test("a region entering the spread freezes at the transition time", () => {
    const field = new StaleSignedVolume();

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 10_000);
    expect(at(field, 15_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 5_000,
    });

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);
    expect(at(field, 30_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 10_000,
    });
  });

  test("stale regions keep aging until live liquidity reaches them again", () => {
    const field = new StaleSignedVolume();

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    field.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    expect(at(field, 30_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 10_000,
    });
    const segment = at(field, 30_000, 0.575);
    expect(segment.volume).toBeCloseTo(-7);
    expect(segment.ageMs).toBe(10_000);

    field.update(makeBook([[0.45, 3]], [[0.6, 20]]), 40_000);
    expect(at(field, 50_000, 0.425)).toMatchObject({
      volume: 3,
      ageMs: 10_000,
    });
  });

  test("snapshot/restore preserves absolute timestamps and explicit unknowns", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    const restored = new StaleSignedVolume();
    restored.restore(field.snapshot());

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

  test("transport hydration rebases finite ages and preserves Infinity", () => {
    const source = new StaleSignedVolume();
    source.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    source.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    const hydrated = new StaleSignedVolume();
    hydrated.restoreSegments(source.segments(35_000), 1_000, source.spread());

    expect(at(hydrated, 2_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 16_000,
    });

    const unknownSource = new StaleSignedVolume();
    unknownSource.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    const unknownHydrated = new StaleSignedVolume();
    unknownHydrated.restoreSegments(
      unknownSource.segments(1_000),
      5_000,
      unknownSource.spread(),
    );
    expect(at(unknownHydrated, 6_000, 0.5).ageMs).toBe(Infinity);
  });
});
