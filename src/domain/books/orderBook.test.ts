import { expect, test } from "bun:test";
import { HalfBook } from "./orderBook";
import { parsePrice, type Price } from "./price";

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

test("HalfBook rejects invalid values without corrupting ordering", () => {
  const book = new HalfBook();
  expect(book.setLevel(Number.NaN as Price, 1)).toBe(false);
  expect(book.setLevel(parsePrice("0.5"), Number.NaN)).toBe(false);
  expect(book.size).toBe(0);
});
