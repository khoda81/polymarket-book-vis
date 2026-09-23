import { emptyTokenBook, type TokenBook } from "./orderBook";
import { parsePrice, type Price } from "./price";

export interface RawBookLevel {
  readonly price: string;
  readonly size: string;
}

export interface RawPriceChange extends RawBookLevel {
  readonly side: string;
}

export interface CanonicalBookChange {
  readonly side: "bid" | "ask";
  readonly price: Price;
  readonly shares: number;
}

export function bookFromSnapshot(
  bids: readonly RawBookLevel[],
  asks: readonly RawBookLevel[],
): TokenBook {
  const book = emptyTokenBook();
  for (const bid of bids) applyLevel(book.usdToYes, bid);
  for (const ask of asks) applyLevel(book.yesToUsd, ask);
  return book;
}

export function applyPriceChange(
  book: TokenBook,
  change: RawPriceChange,
): CanonicalBookChange {
  const price = parsePrice(change.price);
  const shares = parseShares(change.size);
  const side = change.side === "BUY" ? "bid" : "ask";
  const target = side === "bid" ? book.usdToYes : book.yesToUsd;
  target.setLevel(price, shares);
  return { side, price, shares };
}

function applyLevel(target: TokenBook["usdToYes"], level: RawBookLevel): void {
  target.setLevel(parsePrice(level.price), parseShares(level.size));
}

function parseShares(value: string): number {
  const shares = Number(value);
  if (!Number.isFinite(shares) || shares < 0)
    throw new RangeError(`invalid book size: ${value}`);
  return shares;
}
