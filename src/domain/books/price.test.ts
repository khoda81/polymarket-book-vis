import { expect, test } from "bun:test";
import { PRICE_ONE, parsePrice, priceFromTicks } from "./price";

test("decimal spellings canonicalize to the same exact price", () => {
  expect(parsePrice("0.3")).toBe(parsePrice("0.30"));
  expect(parsePrice("0.0025")).toBe(priceFromTicks(25));
  expect(parsePrice("1.0000")).toBe(PRICE_ONE);
});

test("ingestion rejects decimals outside the exact exchange scale", () => {
  expect(() => parsePrice("0.12345")).toThrow();
  expect(() => parsePrice("1.0001")).toThrow();
  expect(() => parsePrice("NaN")).toThrow();
});
