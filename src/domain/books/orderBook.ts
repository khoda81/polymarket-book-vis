import type { Price } from "./price";

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

/** One sorted side of a limit order book, keyed by exact canonical price. */
export class HalfBook {
  /** Ascending by price, one level per price, every take positive. */
  private readonly levels: BookOrder[] = [];

  /** Insert, replace, or (when take is not positive) remove an aggregate level. */
  setLevel(price: Price, take: number): void {
    const index = this.findInsertIndex(price);
    const exists = this.levels[index]?.price === price;
    if (take <= 0) {
      if (exists) this.levels.splice(index, 1);
    } else if (exists) this.levels[index] = { price, take };
    else this.levels.splice(index, 0, { price, take });
  }

  get size(): number {
    return this.levels.length;
  }

  highestOrder(): BookOrder | undefined {
    return this.levels.at(-1);
  }

  lowestOrder(): BookOrder | undefined {
    return this.levels[0];
  }

  /** Iterate high-to-low. */
  *asOrders(): Generator<BookOrder, void, undefined> {
    for (let index = this.levels.length - 1; index >= 0; index--)
      yield this.levels[index]!;
  }

  /** Iterate canonical YES asks low-to-high. */
  *asSellOrders(): Generator<BookOrder, void, undefined> {
    yield* this.levels;
  }

  private findInsertIndex(price: Price): number {
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.levels[mid]!.price < price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
