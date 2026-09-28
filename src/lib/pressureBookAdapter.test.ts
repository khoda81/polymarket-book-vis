import { expect, test } from "bun:test";
import { applyPriceChange, bookFromSnapshot } from "./bookIngestion";
import {
  tokenPressureChanges,
  tokenPressureLevels,
} from "./pressureBookAdapter";
import { feeSchedule, NO_FEE_SCHEDULE, effectiveAskPrice } from "./feeSchedule";
import { parsePrice, priceFromTicks } from "./price";

test("token pressure uses only token-to-collateral asks", () => {
  const book = bookFromSnapshot(
    [{ price: "0.37", size: "12.5" }],
    [{ price: "0.63", size: "8.25" }],
  );
  expect(tokenPressureLevels(book, NO_FEE_SCHEDULE)).toEqual([
    { price: parsePrice("0.63"), shares: 8.25 },
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

  expect(tokenPressureChanges(book, [ask, bid], NO_FEE_SCHEDULE)).toEqual([
    { price: parsePrice("0.63"), shares: 8.25 },
  ]);
});

test("fee projection aggregates colliding raw asks and reaggregates deltas", () => {
  const schedule = feeSchedule(0.04, 1);
  const pair = Array.from({ length: 9_999 }, (_, index) => index + 1).find(
    (raw) =>
      effectiveAskPrice(priceFromTicks(raw), schedule) ===
      effectiveAskPrice(priceFromTicks(raw + 1), schedule),
  );
  expect(pair).toBeDefined();

  const rawA = priceFromTicks(pair!);
  const rawB = priceFromTicks(pair! + 1);
  const effective = effectiveAskPrice(rawA, schedule);
  const book = bookFromSnapshot(
    [],
    [
      { price: (rawA / 10_000).toFixed(4), size: "3" },
      { price: (rawB / 10_000).toFixed(4), size: "5" },
    ],
  );

  expect(tokenPressureLevels(book, schedule)).toEqual([
    { price: effective, shares: 8 },
  ]);

  const change = applyPriceChange(book, {
    side: "SELL",
    price: (rawA / 10_000).toFixed(4),
    size: "4",
  });
  expect(tokenPressureChanges(book, [change], schedule)).toEqual([
    { price: effective, shares: 9 },
  ]);
});
