import { expect, test } from "bun:test";
import { HalfBook, canonicalSpread, emptyTokenBook } from "./orderBook";
import { PRICE_ONE, PRICE_ZERO, parsePrice, type Price } from "./price";

test("setLevel removes an existing aggregate level when take becomes zero", () => {
  const book = new HalfBook();
  book.setLevel(parsePrice("0.50"), 12);

  expect(book.size).toBe(1);
  expect(book.setLevel(parsePrice("0.5"), 0)).toBe(true);
  expect(book.size).toBe(0);
  expect(book.highestOrder()).toBeUndefined();
});

test("canonical price keys unify equivalent decimal spellings", () => {
  const book = new HalfBook();
  book.setLevel(parsePrice("0.30"), 10);
  book.setLevel(parsePrice("0.3"), 20);
  expect([...book.asOrders()]).toEqual([
    { price: parsePrice("0.3"), take: 20 },
  ]);
});

test("canonicalSpread extracts bid/ask prices and their fallbacks", () => {
  const book = emptyTokenBook();
  expect(canonicalSpread(book)).toEqual({ bid: PRICE_ZERO, ask: PRICE_ONE });

  book.usdToYes.setLevel(parsePrice("0.4"), 10);
  book.yesToUsd.setLevel(parsePrice("0.6"), 6);
  expect(canonicalSpread(book)).toEqual({
    bid: parsePrice("0.4"),
    ask: parsePrice("0.6"),
  });
});

test("HalfBook rejects invalid values without corrupting ordering", () => {
  const book = new HalfBook();
  expect(book.setLevel(Number.NaN as Price, 1)).toBe(false);
  expect(book.setLevel(parsePrice("0.5"), Number.NaN)).toBe(false);
  expect(book.size).toBe(0);
});
