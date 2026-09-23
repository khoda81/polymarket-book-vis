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

/**
 * Migrate a legacy binary float that was intended to represent an exchange
 * price. New ingestion must use parsePrice instead.
 */
export function priceFromLegacyNumber(value: number): Price {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError("legacy price must be finite and in [0, 1]");
  const ticks = Math.round(value * PRICE_SCALE);
  if (Math.abs(value - ticks / PRICE_SCALE) > 1e-10)
    throw new RangeError("legacy price is not aligned to a supported tick");
  return priceFromTicks(ticks);
}

/** Convert only at a calculation/rendering boundary. */
export function priceToNumber(value: Price): number {
  return value / PRICE_SCALE;
}

export function complementPrice(value: Price): Price {
  return priceFromTicks(PRICE_SCALE - value);
}

export function formatPrice(value: Price): string {
  const whole = Math.floor(value / PRICE_SCALE);
  const fraction = String(value % PRICE_SCALE)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
