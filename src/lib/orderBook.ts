/**
 * Discriminated union key for orders originating from a parallel merge.
 * The `source` tag preserves traceability so the renderer can pick
 * a per-source color when drawing stacked boxes.
 */
export type MergedKey<A, B> =
  | { readonly source: "left"; readonly key: A }
  | { readonly source: "right"; readonly key: B };

export interface BookOrder {
  /** Conventional price: quote tokens per base token (e.g. USD per YES) */
  price: number;
  /** Amount of get */
  value: number;
}

export interface Slot<Key> extends BookOrder {
  key: Key;
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
  setLevel(key: OrderKey, order: BookOrder): boolean {
    const existing = this.index.get(key);

    if (existing) {
      if (existing.price === order.price)
        return this.updateValue(key, order.value);
      console.warn(
        `Modifyin price of an existing order: `,
        existing,
        `to`,
        order.price,
      );
      this.removeOrder(key);
    }

    const insertIdx = this.findInsertIndex(order.price);

    this.orders.splice(insertIdx, 0, key);
    this.index.set(key, order);

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

  getOrder(key: OrderKey): BookOrder {
    return this.index.get(key) ?? { price: 0, value: 1 };
  }

  bestOrder(): Slot<OrderKey> | undefined {
    const key = this.orders[this.orders.length - 1];
    const order = this.index.get(key);

    return order ? { key, ...order } : undefined;
  }

  *asOrders() {
    for (let i = this.orders.length - 1; i >= 0; i--)
      yield this.index.get(this.orders[i])!;
  }

  /** Yield all slots best-to-worst (descending price), including keys. */
  *asSlots(): Generator<Slot<OrderKey>, void, undefined> {
    for (let i = this.orders.length - 1; i >= 0; i--) {
      const key = this.orders[i];
      yield { key, ...this.index.get(key)! };
    }
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

  // --- Bulk construction (used by merge operations) ---

  /**
   * Build a HalfBook from pre-sorted slots.
   * Slots **must** be sorted ascending by price with no duplicate keys.
   * This bypasses per-insert binary search for O(n) construction.
   */
  private static fromSorted<K>(slots: ReadonlyArray<Slot<K>>): HalfBook<K> {
    const book = new HalfBook<K>();
    for (const { key, price, value } of slots) {
      book.orders.push(key);
      book.index.set(key, { price, value });
    }
    return book;
  }

  // --- Merge operations ---

  /**
   * Parallel merge: liquidity-aggregate two books into a new one.
   *
   * Orders at the same price are kept as **separate entries** (not summed)
   * so that each retains its `MergedKey` source tag for per-source coloring.
   * When prices are equal the left book's order is placed first.
   */
  static parallelMerge<A, B>(
    left: HalfBook<A>,
    right: HalfBook<B>,
  ): HalfBook<MergedKey<A, B>> {
    // Both `orders` arrays are ascending by price — classic two-pointer merge.
    const merged: Slot<MergedKey<A, B>>[] = [];
    let i = 0;
    let j = 0;

    while (i < left.orders.length && j < right.orders.length) {
      const lPrice = left.index.get(left.orders[i])!.price;
      const rPrice = right.index.get(right.orders[j])!.price;

      if (lPrice <= rPrice) {
        const key = left.orders[i];
        const order = left.index.get(key)!;
        merged.push({ key: { source: "left", key }, ...order });
        i++;
      } else {
        const key = right.orders[j];
        const order = right.index.get(key)!;
        merged.push({ key: { source: "right", key }, ...order });
        j++;
      }
    }

    while (i < left.orders.length) {
      const key = left.orders[i];
      const order = left.index.get(key)!;
      merged.push({ key: { source: "left", key }, ...order });
      i++;
    }

    while (j < right.orders.length) {
      const key = right.orders[j];
      const order = right.index.get(key)!;
      merged.push({ key: { source: "right", key }, ...order });
      j++;
    }

    return HalfBook.fromSorted(merged);
  }
}
