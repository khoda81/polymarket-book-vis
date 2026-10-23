/** Exact Polymarket probability price in ten-thousandths. */
export type Price = number & { readonly __priceTicks: unique symbol };

export const PRICE_SCALE = 10_000;
export const PRICE_ZERO = 0 as Price;
export const PRICE_ONE = PRICE_SCALE as Price;

/** Parse the exchange decimal representation without passing through a float. */
export function parsePrice(value: string): Price {
  const match = /^(0|1)(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`invalid price: ${value}`);

  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(4, "0");
  if (whole === 1 && /[1-9]/.test(fraction))
    throw new RangeError(`price must be in [0, 1]: ${value}`);
  return priceFromTicks(whole * PRICE_SCALE + Number(fraction || 0));
}

/** Validate an already-scaled exact price. */
export function priceFromTicks(value: number): Price {
  if (!Number.isSafeInteger(value) || value < 0 || value > PRICE_SCALE)
    throw new RangeError("price ticks must be an integer in [0, 10000]");
  return value as Price;
}

/** Convert only at a calculation/rendering boundary. */
export function priceToNumber(value: Price): number {
  return value / PRICE_SCALE;
}
