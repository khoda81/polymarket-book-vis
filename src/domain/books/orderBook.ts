import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";

export interface BookOrder {
  /** Exact canonical USD/YES probability price, in ten-thousandths. */
  readonly price: Price;
  /** YES shares resting at this level. */
  readonly take: number;
}

export interface TokenBook {
  readonly usdToYes: HalfBook;
  readonly yesToUsd: HalfBook;
}

export function emptyTokenBook(): TokenBook {
  return { usdToYes: new HalfBook(), yesToUsd: new HalfBook() };
}

export function canonicalSpread(book: TokenBook): { bid: Price; ask: Price } {
  return {
    bid: book.usdToYes.highestOrder()?.price ?? PRICE_ZERO,
    ask: book.yesToUsd.lowestOrder()?.price ?? PRICE_ONE,
  };
}

/** One sorted side of a limit order book, keyed by exact canonical price. */
export class HalfBook {
  private prices: Price[] = [];
  private levels = new Map<Price, number>();

  clear(): void {
    this.prices = [];
    this.levels.clear();
  }

  /** Insert, replace, or remove an aggregate level. */
  setLevel(price: Price, take: number): boolean {
    try {
      priceFromTicks(price);
    } catch {
      return false;
    }
    if (!Number.isFinite(take) && take !== Number.POSITIVE_INFINITY)
      return false;
    if (take <= 0) return this.removeLevel(price);

    const existed = this.levels.has(price);
    if (existed) {
      this.levels.set(price, take);
      return true;
    }

    const insertIdx = this.findInsertIndex(price);
    this.prices.splice(insertIdx, 0, price);
    this.levels.set(price, take);
    return false;
  }

  removeLevel(price: Price): boolean {
    if (!this.levels.delete(price)) return false;
    const idx = this.prices.indexOf(price);
    if (idx !== -1) this.prices.splice(idx, 1);
    return true;
  }

  get size(): number {
    return this.prices.length;
  }

  highestOrder(): BookOrder | undefined {
    return this.orderAt(this.prices.length - 1);
  }

  lowestOrder(): BookOrder | undefined {
    return this.orderAt(0);
  }

  /** Iterate high-to-low. */
  *asOrders(): Generator<BookOrder, void, undefined> {
    for (let index = this.prices.length - 1; index >= 0; index--) {
      const order = this.orderAt(index);
      if (order) yield order;
    }
  }

  /** Iterate canonical YES asks low-to-high. */
  *asSellOrders(): Generator<BookOrder, void, undefined> {
    for (let index = 0; index < this.prices.length; index++) {
      const order = this.orderAt(index);
      if (order) yield order;
    }
  }

  private orderAt(index: number): BookOrder | undefined {
    const price = this.prices[index];
    if (price === undefined) return undefined;
    const take = this.levels.get(price);
    return take === undefined ? undefined : { price, take };
  }

  private findInsertIndex(price: Price): number {
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.prices[mid]! < price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
