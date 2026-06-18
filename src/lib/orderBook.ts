export interface BookOrder {
  /** Conventional price: quote tokens per base token (e.g. USD per YES) */
  price: number;
  /** Amount of get */
  value: number;
}

/**
 * Represents a single "wing" (one side) of a limit order book.
 * * By design, this data structure is asymmetrical and maintains only a single,
 * strictly sorted list of orders. To represent a complete order book, you must
 * instantiate two of these classes (e.g., one for the Bid wing, one for the Ask wing).
 *
 * @typeParam OrderKey - The unique identifier type for an order (e.g., string ID).
 */
export class HalfBook<OrderKey> {
  private orders: OrderKey[] = [];
  private index = new Map<OrderKey, BookOrder>();

  clear() {
    this.orders = [];
    this.index.clear();
  }

  /**
   * Insert or replace an order. if the key already exists, it is removed first.
   *
   * @returns `true` if the order key existed. Otherwise, `false`.
   */
  setLevel(key: OrderKey, price: number, value: number): boolean {
    const existing = this.index.get(key);

    if (existing) {
      if (existing.price === price) return this.updateValue(key, value);
      console.warn(
        `Modifyin price of an existing order: `,
        existing,
        `to`,
        price,
      );
      this.removeOrder(key);
    }

    const insertIdx = this.findInsertIndex(price);
    const step: BookOrder = { price, value: value };

    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, step);

    return !!existing;
  }

  /**
   * Update the volume of an existing order.
   */
  updateValue(key: OrderKey, volume: number): boolean {
    if (volume <= 0) return this.removeOrder(key);

    const existing = this.index.get(key);
    if (!existing) return false;
    existing.value = volume;
    return true;
  }

  removeOrder(key: OrderKey): boolean {
    if (!this.index.has(key)) return false;

    this.index.delete(key);
    const idx = this.orders.indexOf(key);
    if (idx !== -1) this.orders.splice(idx, 1);

    return true;
  }

  getOrder(key: OrderKey): BookOrder | undefined {
    return this.index.get(key);
  }

  // TODO: This can be a generator function
  *asOrders() {
    for (const key of this.orders.toReversed()) yield this.index.get(key)!;
    yield { price: 0, value: Infinity };
  }

  /**
   * Re-expresses orders in terms of the complementary token, recovering the original ask prices.
   */
  *asSellOrders() {
    for (const order of this.asOrders()) {
      if (order.price <= 0) break;

      // New Price: How much old Item for 1 unit of old Money?
      const price = 1 / order.price;

      // New Volume: The total old items involved in this order
      const value = order.value * price;

      yield { price, value };
    }

    yield { price: Infinity, value: 0 };
  }

  private findInsertIndex(price: number): number {
    let lo = 0;
    let hi = this.orders.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midPrice = this.index.get(this.orders[mid])!.price;

      if (midPrice === price) return mid;
      if (price > midPrice) lo = mid + 1;
      else hi = mid;
    }

    return lo;
  }
}

export class TokenBook<OrderKey> {
  constructor(
    /** The order book for Give USD, Get YES */
    public usdToYes: HalfBook<OrderKey>,
    /** The order book for Give YES, Get USD */
    public yesToUsd: HalfBook<OrderKey>,
  ) {}
}
