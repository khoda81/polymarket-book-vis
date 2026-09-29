import { expect, test } from "bun:test";
import { parsePrice } from "./price";
import {
  effectiveAskPrice,
  effectiveBidPrice,
  feeSchedule,
  feeScheduleFromMarket,
  NO_FEE_SCHEDULE,
} from "./feeSchedule";

test("zero fee preserves exact venue prices", () => {
  for (const value of ["0", "0.0001", "0.5", "0.9999", "1"]) {
    const price = parsePrice(value);
    expect(effectiveAskPrice(price, NO_FEE_SCHEDULE)).toBe(price);
    expect(effectiveBidPrice(price, NO_FEE_SCHEDULE)).toBe(price);
  }
});

test("effective prices use conservative upper/lower tick boundaries", () => {
  const fee = feeSchedule(0.04, 1);

  // At 50c the fee is exactly 1c/share.
  expect(effectiveAskPrice(parsePrice("0.5"), fee)).toBe(parsePrice("0.51"));
  expect(effectiveBidPrice(parsePrice("0.5"), fee)).toBe(parsePrice("0.49"));

  // .5001 + .04*.5001*.4999 = .5100999996, which belongs to
  // the (.5100, .5101] ask bucket.
  expect(effectiveAskPrice(parsePrice("0.5001"), fee)).toBe(
    parsePrice("0.5101"),
  );
  // Selling receives .4901000004, conservatively represented by .4901.
  expect(effectiveBidPrice(parsePrice("0.5001"), fee)).toBe(
    parsePrice("0.4901"),
  );
});

test("production-like fee curves remain monotone", () => {
  for (const [rate, exponent] of [
    [0.03, 1],
    [0.04, 1],
    [0.05, 1],
    [0.072, 1],
    [0.25, 2],
  ] as const) {
    expect(() => feeSchedule(rate, exponent)).not.toThrow();
  }
});

test("market trading metadata supplies fee schedules without CLOB lookup", () => {
  expect(
    feeScheduleFromMarket({ trading: { feesEnabled: false } }),
  ).toBe(NO_FEE_SCHEDULE);

  const schedule = feeScheduleFromMarket({
    trading: {
      feesEnabled: true,
      feeSchedule: {
        rate: "0.04",
        exponent: 1,
        takerOnly: true,
        rebateRate: "0",
      },
    },
  });
  expect(schedule).not.toBeNull();
  expect(effectiveAskPrice(parsePrice("0.5"), schedule!)).toBe(
    parsePrice("0.51"),
  );
});
