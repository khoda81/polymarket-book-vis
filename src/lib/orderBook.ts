export interface BookOrder {
  price: number;
  size: number;
}

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
    return order ? order : { price: 0, size: 0 };
  }

  /**
   * Insert or replace an order. if the key already exists, it is removed first.
   */
  insertOrder(key: OrderKey, price: number, size: number): boolean {
    const existing = this.index.get(key);

    if (existing) {
      if (existing.price === price) {
        return this.updateSize(key, size);
      }
      this.removeOrder(key);
    }

    const insertIdx = this.findInsertIndex(price);
    const step: BookOrder = { price, size };

    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, step);

    return !!existing;
  }

  /**
   * Update the size of an existing order.
   */
  updateSize(key: OrderKey, size: number): boolean {
    if (size <= 0) return this.removeOrder(key);

    const existing = this.index.get(key);
    if (!existing) return false;
    existing.size = size;
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

  // Returns the raw sorted array for our aggregator
  getSortedKeys(): OrderKey[] {
    return this.orders;
  }

  /**
   * Return a new book representing the same liquidity in the inverse price
   * domain (y -> x). Each block's area is preserved: newSize = oldSize * price.
   */
  toInversePerspective(): OrderBook<OrderKey> {
    const inverted = new OrderBook<OrderKey>();

    for (const key of this.orders.toReversed()) {
      const order = this.getOrder(key);
      if (!order) continue;


      inverted.index.set(key, {
        // The inverted order has reciprocal of this price
        price: 1 / order.price,
        // The volume of this order is the size of inverted order
        size: order.size * order.price
      });

      inverted.orders.push(key);
    }

    // Reverse the order to maintain the correct order in the inverted book
    inverted.orders.reverse();

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