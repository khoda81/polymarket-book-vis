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
  test("live book state is age zero while the initial spread is unknown", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);

    expect(at(field, 1000, 0.3)).toMatchObject({ volume: 10, ageMs: 0 });
    expect(at(field, 1000, 0.5)).toMatchObject({ volume: 0, ageMs: 1000 });
    expect(at(field, 1000, 0.7)).toMatchObject({ volume: -20, ageMs: 0 });
  });

  test("a region entering the spread freezes its last live signed volume", () => {
    const field = new StaleSignedVolume();

    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 0);
    field.update(makeBook([[0.45, 12]], [[0.6, 20]]), 10_000);
    expect(at(field, 15_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 0,
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
    expect(at(field, 30_000, 0.575)).toMatchObject({
      volume: -7,
      ageMs: 10_000,
    });

    field.update(makeBook([[0.45, 3]], [[0.6, 20]]), 40_000);
    expect(at(field, 50_000, 0.425)).toMatchObject({ volume: 3, ageMs: 0 });
  });

  test("snapshot/restore preserves absolute stale timestamps", () => {
    const field = new StaleSignedVolume();
    field.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    field.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    const restored = new StaleSignedVolume();
    restored.restore(field.snapshot());

    expect(at(restored, 35_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 15_000,
    });
  });

  test("transport hydration rebases age onto the browser clock", () => {
    const source = new StaleSignedVolume();
    source.update(makeBook([[0.45, 12]], [[0.55, 7]]), 10_000);
    source.update(makeBook([[0.4, 10]], [[0.6, 20]]), 20_000);

    const hydrated = new StaleSignedVolume();
    hydrated.restoreSegments(source.segments(35_000), 1_000);

    expect(at(hydrated, 2_000, 0.425)).toMatchObject({
      volume: 12,
      ageMs: 16_000,
    });
  });
});
