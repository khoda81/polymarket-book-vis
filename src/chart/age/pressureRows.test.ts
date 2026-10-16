import { expect, test } from "bun:test";
import { PRICE_SCALE } from "@/domain/books/price";
import {
  barFarEdgeX,
  barYDirection,
  sideAtY,
  trackPriceAtDisplayX,
  trackPriceTicks,
} from "./pressureRows";

test("a bar's price axis maps screen x to track price", () => {
  expect(trackPriceAtDisplayX(0.25, "ascending")).toBe(0.25);
  expect(trackPriceAtDisplayX(0.25, "descending")).toBe(0.75);
  expect(trackPriceAtDisplayX(-1, "ascending")).toBe(0);
  expect(trackPriceAtDisplayX(2, "descending")).toBe(0);
  expect(Number(trackPriceTicks(0.75))).toBe(Math.floor(0.75 * PRICE_SCALE));
  expect(barFarEdgeX({ priceAxis: "ascending" })).toBe(1);
  expect(barFarEdgeX({ priceAxis: "descending" })).toBe(0);
});

test("row halves split at the centerline, which belongs below", () => {
  expect(sideAtY(13, 14)).toBe("above");
  expect(sideAtY(14, 14)).toBe("below");
  expect(sideAtY(15, 14)).toBe("below");
  expect(barYDirection({ side: "above" })).toBe(-1);
  expect(barYDirection({ side: "below" })).toBe(1);
});
