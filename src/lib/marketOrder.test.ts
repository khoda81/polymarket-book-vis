import { expect, test } from "bun:test";
import type { Event, MarketId } from "@polymarket/client";
import { orderMarkets } from "./marketOrder";

function eventWithPrices(sortBy: string | undefined, prices: unknown[]): Event {
  return {
    display: { sortBy },
    markets: prices.map((price, index) => ({
      id: String(index),
      state: { active: true, closed: false, acceptingOrders: true },
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

function resolutionMap(
  event: Event,
  values: readonly (string | undefined)[],
): ReadonlyMap<MarketId, number> {
  const result = new Map<MarketId, number>();
  for (const [index, value] of values.entries()) {
    const market = event.markets[index];
    if (market && value !== undefined) result.set(market.id, Date.parse(value));
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
  const ordered = orderMarkets(event, thresholdMap(event, [0, 1, 2, 3, 4, 5]));
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

test("threshold order outranks misleading deadlines from the live airspace event", () => {
  const base = eventWithPrices("ascending", [null, null, null]);
  const marketIds = ["3128769", "3128768", "4620250"];
  const event = {
    ...base,
    markets: base.markets.map((market, index) => ({
      ...market,
      id: marketIds[index]!,
    })),
  } as Event;

  expect(
    ids(
      orderMarkets(
        event,
        thresholdMap(event, [4, 6, 5]),
        resolutionMap(event, [
          "2027-01-26T04:59:00Z",
          "2027-01-26T04:59:00Z",
          "2026-11-01T03:59:00Z",
        ]),
      ),
    ),
  ).toEqual(["3128769", "4620250", "3128768"]);
});

test("resolved deadlines anchor a circular threshold ladder before its live suffix", () => {
  // Live Gamma event 634802 has threshold keys 0..10, but zero is July 27:
  // the historical June/July prefix wraps around to slots 7..10.
  const rows = [
    ["jun-30", 7, "2026-07-01T03:59:00Z", false],
    ["jul-15", 8, "2026-07-16T03:59:00Z", false],
    ["jul-31", 1, "2026-08-01T03:59:00Z", false],
    ["aug-31", 3, "2026-09-01T03:59:00Z", false],
    ["jul-21", 9, "2026-07-22T03:59:00Z", false],
    ["jul-24", 10, "2026-07-25T03:59:00Z", false],
    ["aug-15", 2, "2026-08-16T03:59:00Z", false],
    ["jul-27", 0, "2026-07-28T03:59:00Z", false],
    ["sep-30", 4, "2027-01-26T04:59:00Z", true],
    ["dec-31", 6, "2027-01-26T04:59:00Z", true],
    ["oct-31", 5, "2026-11-01T03:59:00Z", true],
  ] as const;
  const event = {
    display: { sortBy: "ascending" },
    markets: rows.map(([id, , , live]) => ({
      id,
      state: { active: true, closed: !live, acceptingOrders: live },
      outcomes: { yes: { price: null } },
    })),
  } as unknown as Event;
  const thresholds = new Map<MarketId, number>(
    event.markets.map((market, index) => [market.id, rows[index]![1]]),
  );
  const resolutions = new Map<MarketId, number>(
    event.markets.map((market, index) => [
      market.id,
      Date.parse(rows[index]![2]),
    ]),
  );

  expect(ids(orderMarkets(event, thresholds, resolutions))).toEqual([
    "jun-30",
    "jul-15",
    "jul-21",
    "jul-24",
    "jul-27",
    "jul-31",
    "aug-15",
    "aug-31",
    "sep-30",
    "oct-31",
    "dec-31",
  ]);
});

test("deadlines order markets only when explicit display values are absent", () => {
  const event = eventWithPrices("ascending", [null, null, null]);
  expect(
    ids(
      orderMarkets(
        event,
        new Map(),
        resolutionMap(event, [
          "2026-12-31T23:59:00Z",
          "2026-10-31T23:59:00Z",
          undefined,
        ]),
      ),
    ),
  ).toEqual(["1", "0", "2"]);
});

test("empty and singleton events retain their markets", () => {
  for (const mode of ["price", "ascending", "descending"]) {
    expect(orderMarkets(eventWithPrices(mode, []), new Map())).toEqual([]);
    expect(ids(orderMarkets(eventWithPrices(mode, [null]), new Map()))).toEqual(
      ["0"],
    );
  }
});
