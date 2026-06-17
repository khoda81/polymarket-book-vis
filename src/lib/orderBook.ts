export interface BookOrder {
  /** Amount of get over amount of give */
  price: number;
  /** Amount of get */
  value: number;
}

/**
 * Represents a single "wing" (one side) of a limit order book.
 * * By design, this data structure is asymmetrical and maintains only a single,
 * strictly sorted list of orders. To represent a complete order book, you must
 * instantiate two of these classes (e.g., one for the Bid wing, one for the Ask wing).
 * * @remarks
 * In complementary prediction markets (like Polymarket where Yes + No = 1),
 * you can maintain a minimal state model by treating all orders as Asks.
 * A Bid for a 'Yes' token is mathematically identical to an Ask for a 'No' token.
 * This allows you to use two identical instances of this class to form the full
 * book without needing custom bidirectional sorting logic.
 * * @typeParam OrderKey - The unique identifier type for an order (e.g., string ID).
 */
export class OrderBook<OrderKey> {
  private orders: OrderKey[] = [];
  private index = new Map<OrderKey, BookOrder>();

  clear() {
    this.orders = [];
    this.index.clear();
  }

  /**
   * Returns the best order in the book, or null order if the book is empty.
   */
  getBestOrder(): BookOrder {
    const order = this.index.get(this.orders[0]);
    return order ? order : { price: 0, value: 0 };
  }

  /**
   * Insert or replace an order. if the key already exists, it is removed first.
   */
  insertOrder(key: OrderKey, price: number, volume: number): boolean {
    const existing = this.index.get(key);

    if (existing) {
      if (existing.price === price) {
        return this.updateVolume(key, volume);
      }
      this.removeOrder(key);
    }

    const insertIdx = this.findInsertIndex(price);
    const step: BookOrder = { price, value: volume };

    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, step);

    return !!existing;
  }

  /**
   * Update the volume of an existing order.
   */
  updateVolume(key: OrderKey, volume: number): boolean {
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

  entriesDescending(): BookOrder[] {
    return this.orders
      .map((key) => this.index.get(key))
      .filter((order): order is BookOrder => order !== undefined)
      .map((order) => ({ ...order }))
      .reverse();
  }

  /**
   * Flips the market perspective (e.g., from YES/NO to NO/YES).
   * The old "Money" becomes the new "Item".
   */
  toInversePerspective(): BookOrder[] {
    const inverted = [];

    for (const key of this.orders) {
      const order = this.getOrder(key);
      if (!order) continue;

      // New Price: How much old Item for 1 unit of old Money?
      const invertedPrice = 1 / order.price;

      // New Volume: The total old items involved in this order
      const invertedValue = order.value * invertedPrice;

      inverted.push({ price: invertedPrice, value: invertedValue });
    }

    inverted.reverse();

    return inverted;
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

export class EventBook<OrderKey> {
  constructor(
    /** The order book for Give USD, Get YES */
    public usdToYes: OrderBook<OrderKey>,
    /** The order book for Give YES, Get USD */
    public yesToUsd: OrderBook<OrderKey>,
  ) {}
}
