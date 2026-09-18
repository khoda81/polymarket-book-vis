export interface BookOrder {
  /** Price: give tokens per take token (e.g. USD per YES — give USD, take YES). */
  price: number;
  /** Amount of take (the token the order receives). give = price * take. */
  take: number;
}

export interface Slot<Key> extends BookOrder {
  key: Key;
}

export interface TokenBook<K = string> {
  /** Give USD, get YES. Prices are canonical USD/YES bids. */
  usdToYes: HalfBook<K>;
  /** Give YES, get USD. Prices are stored as the inverse canonical ask. */
  yesToUsd: HalfBook<K>;
}

export function emptyTokenBook(): TokenBook<string> {
  return { usdToYes: new HalfBook(), yesToUsd: new HalfBook() };
}

/** Extract the canonical YES spread, including the book's natural fallbacks. */
export function canonicalSpread(book: TokenBook<unknown>): {
  bid: number;
  ask: number;
} {
  const bid = book.usdToYes.bestOrder()?.price ?? 0;
  const inverseAsk = book.yesToUsd.bestOrder()?.price ?? 1;
  return { bid, ask: 1 / inverseAsk };
}

/**
 * One sorted side of a limit order book.
 *
 * Values are stored as {price, take}; give is derived as price * take. The
 * class owns stored order values and only exposes copies, so callers cannot
 * mutate a price behind the sorted-index invariant.
 */
export class HalfBook<OrderKey> {
  private orders: OrderKey[] = [];
  private index = new Map<OrderKey, BookOrder>();

  clear(): void {
    this.orders = [];
    this.index.clear();
  }

  /**
   * Insert or replace an aggregate level.
   *
   * price must be positive and non-NaN. take <= 0 removes an existing level,
   * matching Polymarket delta semantics. Infinity remains allowed because the
   * synthetic mint route uses infinite capacity.
   */
  setLevel(key: OrderKey, order: BookOrder): boolean {
    if (Number.isNaN(order.price) || order.price <= 0) return false;
    if (Number.isNaN(order.take)) return false;
    if (order.take <= 0) return this.removeOrder(key);

    const existing = this.index.get(key);
    if (existing) {
      if (existing.price === order.price)
        return this.updateTake(key, order.take);
      this.removeOrder(key);
    }

    const insertIdx = this.findInsertIndex(order.price);
    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, { price: order.price, take: order.take });
    return !!existing;
  }

  /** Update only the amount of an existing level. */
  updateTake(key: OrderKey, take: number): boolean {
    if (Number.isNaN(take)) return false;
    if (take <= 0) return this.removeOrder(key);

    const existing = this.index.get(key);
    if (!existing) return false;
    existing.take = take;
    return true;
  }

  removeOrder(key: OrderKey): boolean {
    if (!this.index.has(key)) return false;

    this.index.delete(key);
    const idx = this.orders.indexOf(key);
    if (idx !== -1) this.orders.splice(idx, 1);
    return true;
  }

  get size(): number {
    return this.orders.length;
  }

  bestOrder(): Slot<OrderKey> | undefined {
    const key = this.orders[this.orders.length - 1];
    const order = this.index.get(key);
    return order ? { key, ...order } : undefined;
  }

  /** Iterate best-to-worst (descending stored price), returning value copies. */
  *asOrders(): Generator<BookOrder, void, undefined> {
    for (let i = this.orders.length - 1; i >= 0; i--)
      yield { ...this.index.get(this.orders[i]!)! };
  }

  /**
   * Iterate the inverse book in canonical coordinates.
   *
   * Stored price is give/take; inversion maps price -> 1/price and
   * take -> give = price * take.
   */
  *asSellOrders(): Generator<BookOrder, void, undefined> {
    for (const order of this.asOrders()) {
      const price = 1 / order.price;
      const take = order.price * order.take;
      yield { price, take };
    }
  }

  private findInsertIndex(price: number): number {
    let lo = 0;
    let hi = this.orders.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midPrice = this.index.get(this.orders[mid]!)!.price;
      if (midPrice === price) return mid;
      if (price > midPrice) lo = mid + 1;
      else hi = mid;
    }

    return lo;
  }
}
