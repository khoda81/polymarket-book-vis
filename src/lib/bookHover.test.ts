import { describe, expect, test } from "bun:test";
import { bookHoverAtPrice } from "./bookHover";
import { HalfBook, type TokenBook } from "./orderBook";

function makeBook(): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  usdToYes.setLevel("0.40", { price: 0.4, take: 100 });
  usdToYes.setLevel("0.30", { price: 0.3, take: 50 });

  const yesToUsd = new HalfBook<string>();
  yesToUsd.setLevel("0.60", { price: 1 / 0.6, take: 60 });
  yesToUsd.setLevel("0.80", { price: 1 / 0.8, take: 80 });
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });
  return { usdToYes, yesToUsd };
}

describe("book hover statistics", () => {
  test("reports cumulative bid shares and YES VWAP", () => {
    const hover = bookHoverAtPrice(makeBook(), 0.25);
    expect(hover.side).toBe("bid");
    expect(hover.shares).toBe(150);
    expect(hover.effectivePrice).toBeCloseTo((100 * 0.4 + 50 * 0.3) / 150);
  });

  test("reports the live spread as empty", () => {
    expect(bookHoverAtPrice(makeBook(), 0.5)).toEqual({
      price: 0.5,
      side: "spread",
      shares: 0,
      effectivePrice: null,
    });
  });

  test("reports cumulative ask shares and YES VWAP", () => {
    const hover = bookHoverAtPrice(makeBook(), 0.9);
    expect(hover.side).toBe("ask");
    expect(hover.shares).toBe(200);
    expect(hover.effectivePrice).toBeCloseTo((100 * 0.6 + 100 * 0.8) / 200);
  });
});
