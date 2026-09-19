import { expect, test } from "bun:test";
import {
  emptyTokenBook,
  type TokenBook,
} from "@/lib/orderBook";
import { AgeStripPressureState } from "./ageStripPressureState";

function bidBook(
  shares: number,
  price = 0.5,
): TokenBook<string> {
  const book = emptyTokenBook();
  book.usdToYes.setLevel(String(price), {
    price,
    take: shares,
  });
  return book;
}

test("pressure book updates coalesce until the next rendered frame", () => {
  const state = new AgeStripPressureState();
  state.configure([
    { tokenId: "yes", resolutionMs: null },
  ]);

  state.queueBookUpdate("yes", bidBook(10));
  state.queueBookUpdate("yes", bidBook(25));

  expect(state.cells("yes")[0]?.bands).toEqual([]);

  state.flushBookUpdates(1_000);
  expect(state.cells("yes")[0]?.bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 25,
      side: 1,
      state: { kind: "live" },
    },
  ]);
});

test("resolution flushes the latest queued book before ghosting it", () => {
  const state = new AgeStripPressureState();
  state.configure([
    { tokenId: "yes", resolutionMs: 2_000 },
  ]);

  state.queueBookUpdate("yes", bidBook(40));
  state.resolve("yes", 2_000);

  expect(state.cells("yes")[0]?.bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 40,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});
