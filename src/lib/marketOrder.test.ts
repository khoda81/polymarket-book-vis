import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
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

const ids = (markets: Event["markets"]): string[] => markets.map((market) => market.id);

test("price mode orders by Yes price descending, not threshold, without mutating input", () => {
  // No Head of State, Mojtaba, Reza, Ahmadinejad, Rouhani, Arafi.
  const event = eventWithPrices("price", ["0.047", "0.834", "0.025", "0.0135", "0.008", "0.007"]);
  const original = [...event.markets];
  const raw = event.markets.map((market, index) => ({
    id: market.id,
    groupItemThreshold: String(index),
  }));
  const ordered = orderMarkets(event, raw);
  expect(ids(ordered)).toEqual(["1", "0", "2", "3", "4", "5"]);
  expect(event.markets).toEqual(original);
  expect(ordered).not.toBe(event.markets);
  expect(ordered[0]).toBe(original[1]);
});

test("price ties stay stable and missing or invalid prices follow zero", () => {
  const event = eventWithPrices("price", [null, "0", "0.5", "0.5", undefined, "", "bad", Infinity]);
  expect(ids(orderMarkets(event, []))).toEqual(["2", "3", "1", "0", "4", "5", "6", "7"]);
});

test("threshold modes retain direction, stable ties, and put missing values last", () => {
  const raw = [
    { id: "0", groupItemThreshold: "2" },
    { id: "1", groupItemThreshold: "0" },
    { id: "2", groupItemThreshold: "2" },
    { id: "3", groupItemThreshold: "invalid" },
    { id: "4", groupItemThreshold: "" },
    null,
  ];
  for (const mode of [undefined, "ascending", "unknown", "descending"]) {
    const event = eventWithPrices(mode, [null, null, null, null, null, null]);
    expect(ids(orderMarkets(event, raw))).toEqual(
      mode === "descending"
        ? ["0", "2", "1", "3", "4", "5"]
        : ["1", "0", "2", "3", "4", "5"],
    );
  }
});

test("empty and singleton events retain their markets", () => {
  for (const mode of ["price", "ascending", "descending"]) {
    expect(orderMarkets(eventWithPrices(mode, []), [])).toEqual([]);
    expect(ids(orderMarkets(eventWithPrices(mode, [null]), []))).toEqual(["0"]);
  }
});
