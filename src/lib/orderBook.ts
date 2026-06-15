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
   * Insert or replace an order. if the key already
   * exists, it is removed first.
   */
  insertOrder(key: OrderKey, price: number, size: number): boolean {
    const existing = this.index.get(key);
    if (existing?.price === price) {
      return this.updateSize(key, size);
    }

    const exists = this.removeOrder(key);
    const insertIdx = this.findInsertIndex(price);
    const step: BookOrder = { price, size };
    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, step);
    return exists;
  }

  /**
   * Update the size of an existing order.
   */
  updateSize(key: OrderKey, size: number): boolean {
    if (size === 0)
      // Remove the order from index, the order list will be cleaned up later
      return this.index.delete(key);

    const existing = this.index.get(key);
    if (!existing) return false;
    existing.size = size;
    return true;
  }

  removeOrder(key: OrderKey): boolean {
    return this.updateSize(key, 0)
  }

  getOrder(key: OrderKey): BookOrder | undefined {
    return this.index.get(key);
  }

  hasOrder(key: OrderKey): boolean {
    return this.index.has(key);
  }

  /**
   * Return a new book representing the same liquidity in the inverse price
   * domain (y -> x). Each block's area is preserved: newSize = oldSize * price.
   */
  toInversePerspective(): OrderBook<OrderKey> {
    const inverted = new OrderBook<OrderKey>();

    for (const key of this.orders) {
      const order = this.getOrder(key);
      if (!order) continue;

      // The inverted order has reciprocal of this price
      const invertedPrice = 1 / order.price;

      // The volume of this order is the size of inverted order
      const invertedSize = order.size * order.price;
      inverted.insertOrder(key, invertedPrice, invertedSize);
    }

    return inverted;
  }

  private findInsertIndex(price: number): number {
    let lo = 0;
    let hi = this.orders.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midOrder = this.getOrder(this.orders[mid]);
      const midPrice = midOrder?.price;

      // This shouldn't happen right? midPrice should never be undefined I think
      if (midPrice === undefined || midPrice === price) return mid;

      if (price < midPrice) hi = mid;
      else lo = mid + 1;
    }

    return lo;
  }
}
