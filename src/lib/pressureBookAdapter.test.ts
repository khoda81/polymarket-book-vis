import { expect, test } from "bun:test";
import { applyPriceChange, bookFromSnapshot } from "./bookIngestion";
import { pressureEdgeChanges, pressureEdgeLevels } from "./pressureBookAdapter";
import { parsePrice } from "./price";

test("asks become primary-token to collateral levels", () => {
  const book = bookFromSnapshot([], [{ price: "0.63", size: "8.25" }]);
  expect(pressureEdgeLevels(book).primaryToCollateral).toEqual([
    { key: parsePrice("0.63"), weight: 8.25 },
  ]);
});

test("bids become complemented opposite-token to collateral levels", () => {
  const book = bookFromSnapshot([{ price: "0.37", size: "12.5" }], []);
  expect(pressureEdgeLevels(book).oppositeToCollateral).toEqual([
    { key: parsePrice("0.63"), weight: 12.5 },
  ]);
});

test("incremental changes use the same edge canonicalization", () => {
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

  expect(pressureEdgeChanges([ask, bid])).toEqual({
    primaryToCollateral: [{ price: parsePrice("0.63"), shares: 8.25 }],
    oppositeToCollateral: [{ price: parsePrice("0.63"), shares: 12.5 }],
  });
});
