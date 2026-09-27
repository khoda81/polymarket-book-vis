import { expect, test } from "bun:test";
import { applyPriceChange, bookFromSnapshot } from "./bookIngestion";
import { tokenPressureChanges, tokenPressureLevels } from "./pressureBookAdapter";
import { parsePrice } from "./price";

test("token pressure uses only token-to-collateral asks", () => {
  const book = bookFromSnapshot(
    [{ price: "0.37", size: "12.5" }],
    [{ price: "0.63", size: "8.25" }],
  );
  expect(tokenPressureLevels(book)).toEqual([
    { key: parsePrice("0.63"), weight: 8.25 },
  ]);
});

test("incremental token pressure ignores bids", () => {
  const book = bookFromSnapshot([], []);
  const ask = applyPriceChange(book, {
    side: "SELL",
    price: "0.63",
    size: "8.25",
  });
  const bid = applyPriceChange(book, {
    side: "BUY",
    price: "0.37",
    size: "12.5",
  });

  expect(tokenPressureChanges([ask, bid])).toEqual([
    { price: parsePrice("0.63"), shares: 8.25 },
  ]);
});
