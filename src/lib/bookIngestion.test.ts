import { expect, test } from "bun:test";
import { applyPriceChange, bookFromSnapshot } from "./bookIngestion";
import { parsePrice } from "./price";

test("ask snapshot, alternate decimal update, and deletion share one level", () => {
  const book = bookFromSnapshot([], [{ price: "0.38", size: "100" }]);

  applyPriceChange(book, {
    side: "SELL",
    price: "0.3800",
    size: "125",
  });
  expect([...book.yesToUsd.asSellOrders()]).toEqual([
    { price: parsePrice("0.38"), take: 125 },
  ]);

  applyPriceChange(book, {
    side: "SELL",
    price: "0.380",
    size: "0",
  });
  expect(book.yesToUsd.size).toBe(0);
});

test("snapshot ingestion stores direct YES prices and shares on both sides", () => {
  const book = bookFromSnapshot(
    [{ price: "0.37", size: "12.5" }],
    [{ price: "0.63", size: "8.25" }],
  );
  expect([...book.usdToYes.asOrders()]).toEqual([
    { price: parsePrice("0.37"), take: 12.5 },
  ]);
  expect([...book.yesToUsd.asSellOrders()]).toEqual([
    { price: parsePrice("0.63"), take: 8.25 },
  ]);
});
