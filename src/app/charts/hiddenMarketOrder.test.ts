import { expect, test } from "bun:test";
import { hiddenMarketDisplayOrder } from "./hiddenMarketOrder";

test("hidden markets start from the card-order edge selected by row orientation", () => {
  const cardOrder = ["higher", "middle", "lower"];

  expect(hiddenMarketDisplayOrder(cardOrder, "positive-above")).toEqual([
    "higher",
    "middle",
    "lower",
  ]);
  expect(hiddenMarketDisplayOrder(cardOrder, "negative-above")).toEqual([
    "lower",
    "middle",
    "higher",
  ]);
  expect(cardOrder).toEqual(["higher", "middle", "lower"]);
});
