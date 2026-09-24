import { expect, test } from "bun:test";
import type { Event, MarketId } from "@polymarket/client";
import { orderMarkets } from "./marketOrder";

function eventWithPrices(sortBy: string | undefined, prices: unknown[]): Event {
  return {
    display: { sortBy },
    markets: prices.map((price, index) => ({
      id: String(index),
      outcomes: { yes: { price } },
    })),
  } as unknown as Event;
}

function thresholdMap(
  event: Event,
  values: readonly (number | undefined)[],
): ReadonlyMap<MarketId, number> {
  const result = new Map<MarketId, number>();
  for (const [index, value] of values.entries()) {
    if (value === undefined) continue;
    const market = event.markets[index];
    if (market) result.set(market.id, value);
  }
  return result;
}

const ids = (markets: Event["markets"]): string[] =>
  markets.map((market) => market.id);

test("price mode orders by Yes price descending, not threshold, without mutating input", () => {
  // No Head of State, Mojtaba, Reza, Ahmadinejad, Rouhani, Arafi.
  const event = eventWithPrices("price", [
    "0.047",
    "0.834",
    "0.025",
    "0.0135",
    "0.008",
    "0.007",
  ]);
  const original = [...event.markets];
  const ordered = orderMarkets(
    event,
    thresholdMap(event, [0, 1, 2, 3, 4, 5]),
  );
  expect(ids(ordered)).toEqual(["1", "0", "2", "3", "4", "5"]);
  expect(event.markets).toEqual(original);
  expect(ordered).not.toBe(event.markets);
  expect(ordered[0]).toBe(original[1]);
});

test("price ties stay stable and missing or invalid prices follow zero", () => {
  const event = eventWithPrices("price", [
    null,
    "0",
    "0.5",
    "0.5",
    undefined,
    "",
    "bad",
    Infinity,
  ]);
  expect(ids(orderMarkets(event, new Map()))).toEqual([
    "2",
    "3",
    "1",
    "0",
    "4",
    "5",
    "6",
    "7",
  ]);
});

test("threshold modes retain direction, stable ties, and put missing values last", () => {
  for (const mode of [undefined, "ascending", "unknown", "descending"]) {
    const event = eventWithPrices(mode, [null, null, null, null, null, null]);
    const thresholds = thresholdMap(event, [2, 0, 2, undefined, undefined]);
    expect(ids(orderMarkets(event, thresholds))).toEqual(
      mode === "descending"
        ? ["0", "2", "1", "3", "4", "5"]
        : ["1", "0", "2", "3", "4", "5"],
    );
  }
});

test("empty and singleton events retain their markets", () => {
  for (const mode of ["price", "ascending", "descending"]) {
    expect(orderMarkets(eventWithPrices(mode, []), new Map())).toEqual([]);
    expect(
      ids(orderMarkets(eventWithPrices(mode, [null]), new Map())),
    ).toEqual(["0"]);
  }
});
