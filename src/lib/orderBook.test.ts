import { expect, test } from "bun:test";
import { HalfBook, canonicalSpread, emptyTokenBook } from "./orderBook";

test("setLevel removes an existing aggregate level when take becomes zero", () => {
  const book = new HalfBook<string>();
  book.setLevel("0.50", { price: 0.5, take: 12 });

  expect(book.size).toBe(1);
  expect(book.setLevel("0.50", { price: 0.5, take: 0 })).toBe(true);
  expect(book.size).toBe(0);
  expect(book.bestOrder()).toBeUndefined();
});

test("canonicalSpread extracts bid/ask prices and their fallbacks", () => {
  const book = emptyTokenBook();
  expect(canonicalSpread(book)).toEqual({ bid: 0, ask: 1 });

  book.usdToYes.setLevel("bid", { price: 0.4, take: 10 });
  book.yesToUsd.setLevel("ask", { price: 1 / 0.6, take: 6 });
  expect(canonicalSpread(book)).toEqual({ bid: 0.4, ask: 0.6 });
});
