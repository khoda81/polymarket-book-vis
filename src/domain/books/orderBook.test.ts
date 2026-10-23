import { expect, test } from "bun:test";
import { HalfBook } from "./orderBook";
import { parsePrice } from "./price";

test("setLevel removes an existing aggregate level when take becomes zero", () => {
  const book = new HalfBook();
  book.setLevel(parsePrice("0.50"), 12);

  expect(book.size).toBe(1);
  book.setLevel(parsePrice("0.5"), 0);
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

test("levels stay sorted and removal finds the level by price", () => {
  const book = new HalfBook();
  for (const [price, take] of [
    ["0.5", 1],
    ["0.2", 2],
    ["0.8", 3],
    ["0.4", 4],
  ] as const)
    book.setLevel(parsePrice(price), take);
  book.setLevel(parsePrice("0.4"), 0);
  book.setLevel(parsePrice("0.9"), 0);

  expect([...book.asSellOrders()].map(({ price }) => price)).toEqual(
    ["0.2", "0.5", "0.8"].map(parsePrice),
  );
  expect(book.highestOrder()).toEqual({ price: parsePrice("0.8"), take: 3 });
  expect(book.lowestOrder()).toEqual({ price: parsePrice("0.2"), take: 2 });
});
