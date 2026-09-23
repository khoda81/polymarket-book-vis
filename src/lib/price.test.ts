import { expect, test } from "bun:test";
import {
  PRICE_ONE,
  complementPrice,
  formatPrice,
  parsePrice,
  priceFromTicks,
  priceToNumber,
} from "./price";

test("decimal spellings canonicalize to the same exact price", () => {
  expect(parsePrice("0.3")).toBe(parsePrice("0.30"));
  expect(parsePrice("0.0025")).toBe(priceFromTicks(25));
  expect(parsePrice("1.0000")).toBe(PRICE_ONE);
});

test("price complements and formatting stay exact", () => {
  const price = parsePrice("0.013");
  expect(complementPrice(complementPrice(price))).toBe(price);
  expect(formatPrice(complementPrice(price))).toBe("0.987");
  expect(priceToNumber(price)).toBe(0.013);
});

test("ingestion rejects decimals outside the exact exchange scale", () => {
  expect(() => parsePrice("0.12345")).toThrow();
  expect(() => parsePrice("1.0001")).toThrow();
  expect(() => parsePrice("NaN")).toThrow();
});
