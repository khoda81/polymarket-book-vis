/**
 * Discriminated union key for orders originating from a parallel merge.
 * The `source` tag preserves traceability so the renderer can pick
 * a per-source color when drawing stacked boxes.
 */
export type MergedKey<A, B> =
  | { readonly source: "left"; readonly key: A }
  | { readonly source: "right"; readonly key: B };

export interface BookOrder {
  /** Price: give tokens per take token (e.g. USD per YES — give USD, take YES) */
  price: number;
  /** Amount of give (the token the order spends) */
  value: number;
}

export interface Slot<Key> extends BookOrder {
  key: Key;
}

/**
 * Represents a single "wing" (one side) of a limit order book.
 * By design, this data structure is asymmetrical and maintains only a single,
 * strictly sorted list of orders. To represent a complete order book, you must
 * instantiate two of these classes (e.g., one wing giving the priced token,
 * one wing giving the pricing token).
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

  get size(): number {
    return this.orders.length;
  }

  bestOrder(): Slot<OrderKey> | undefined {
    const key = this.orders[this.orders.length - 1];
    const order = this.index.get(key);

    return order ? { key, ...order } : undefined;
  }

  /** A shallow copy (orders + index rebuilt). Used by simulated merges. */
  clone(): HalfBook<OrderKey> {
    return HalfBook.fromSorted(this.asSlotsAscending());
  }

  /**
   * Consume up to `limit` units from the best (highest-priced) order.
   *
   * Mutates this book: decrements the top order's volume and removes it once
   * exhausted. Total: an empty book is treated as a price-0 sink — you can
   * always clear `limit` for nothing — so this always returns a fill,
   * `{ price: 0, consumed: limit }` when the book is empty.
   */
  takeBest(limit: number): { price: number; consumed: number } {
    if (this.orders.length === 0) return { price: 0, consumed: limit };

    const key = this.orders[this.orders.length - 1];
    const order = this.index.get(key)!;
    const consumed = Math.min(order.value, limit);

    if (consumed >= order.value) this.removeOrder(key);
    else order.value -= consumed;

    return { price: order.price, consumed };
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

  /** Yield all slots ascending by price (worst-to-best when higher price is better). */
  *asSlotsAscending(): Generator<Slot<OrderKey>, void, undefined> {
    for (let i = 0; i < this.orders.length; i++) {
      const key = this.orders[i];
      yield { key, ...this.index.get(key)! };
    }
  }

  /**
   * Invert the book: swap give and take. The original give token becomes the
   * new take token and vice versa. New price = 1/old.price (take per give
   * becomes give per take); new value = old.value / old.price = the old take
   * amount, which is the new give amount.
   */
  *asSellOrders() {
    for (const order of this.asOrders()) {
      if (order.price <= 0) break;

      // New price: the inverse ratio.
      const price = 1 / order.price;

      // New volume: old take amount = old give / price (= old.value / old.price).
      const value = order.value / order.price;

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
   * Build a HalfBook from slots sorted **ascending by price** with no
   * duplicate keys. O(n) construction bypassing per-insert binary search.
   */
  static fromSorted<K>(slots: Iterable<Slot<K>>): HalfBook<K> {
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

  /**
   * Simulated merge: combine two books by repeatedly consuming the cheaper
   * top order from either side, bottlenecking on the smaller volume at each
   * step. Unlike `parallelMerge`, this **sums** liquidity at overlapping
   * price levels instead of keeping entries separate — so it models the
   * aggregate book you'd get by routing flow to whichever source is cheaper.
   *
   * Both inputs are consumed via `takeBest` on private clones, so the caller's
   * books are left untouched. Because `takeBest` is total (an empty book acts
   * as a price-0 sink), the loop terminates only when `limit` is reached or
   * both books are empty — at which point further fills would be price-0
   * throwaways, which we don't record.
   *
   * @param limit Optional cap on total volume to simulate. Defaults to
   *              `Infinity` (drain both books completely).
   */
  static simulatedMerge<A, B>(
    left: HalfBook<A>,
    right: HalfBook<B>,
    limit: number = Infinity,
  ): HalfBook<MergedKey<A, B>> {
    const a = left.clone() as HalfBook<A>;
    const b = right.clone() as HalfBook<B>;

    const merged: Slot<MergedKey<A, B>>[] = [];
    let remaining = limit;

    while (remaining > 0 && (a.size > 0 || b.size > 0)) {
      const topA = a.bestOrder();
      const topB = b.bestOrder();
      const priceA = topA?.price ?? 0;
      const priceB = topB?.price ?? 0;

      // Route to the cheaper top. An empty book has price 0, so a non-empty
      // book always wins; if both are empty the loop guard already exited.
      const takeFromA = priceA <= priceB;
      const source = takeFromA ? a : b;
      const top = takeFromA ? topA : topB;

      const fill = source.takeBest(remaining);
      // `takeBest` is total, but a price-0 sink fill (empty book) carries no
      // real liquidity — skip recording it and stop.
      if (!top) break;

      const key = top.key as unknown as A | B;
      const tag: MergedKey<A, B> = takeFromA
        ? { source: "left", key: key as A }
        : { source: "right", key: key as B };

      merged.push({ key: tag, price: fill.price, value: fill.consumed });
      remaining -= fill.consumed;
    }

    // `takeBest` always pulls the current top, so successive fills are
    // non-increasing in price — i.e. descending. `fromSorted` needs ascending.
    merged.reverse();
    return HalfBook.fromSorted(merged);
  }
}

/**
 * Discriminated union key for orders produced by a series merge.
 * Both legs must be filled simultaneously, so the key carries the pair.
 */
export interface SeriesKey<A, B> {
  readonly left: A;
  readonly right: B;
}

/**
 * Series merge: synthesize a new book by executing on two books simultaneously.
 *
 * Walks both slot streams in lockstep, bottlenecking on the smaller volume at
 * each level and combining prices via `combinePrice`. The resulting slots are
 * yielded in the **same order** as the inputs (best-first if both inputs are
 * best-first), so the output can be fed directly to `HalfBook.fromSorted` only
 * when that order is ascending by price — see the usage notes below.
 *
 * ## Price combinators
 *
 * - **Additive** `(p, q) => p + q`: disjoint-outcome union (`A | B = A + B`),
 *   basket assembly. Pair take-legs with take-legs to synthesize a take
 *   (buy a basket by buying each component), give-legs with give-legs to
 *   synthesize a give (sell a basket by selling each component).
 *
 * - **Subtractive** `(p, q) => p - q`: difference token `X \ Y` where `Y ⊆ X`.
 *   To synthesize `USD->(X\Y)` (buy the gap) pair `USD->X` with `Y->USD`
 *   (take of the wide token, **give** of the narrow token you must unload):
 *   `combinePrice = (takeX, giveY) => takeX - giveY`.
 *   To synthesize `(X\Y)->USD` (sell the gap) pair `X->USD` with `USD->Y`
 *   (give of the wide token, **take** of the narrow token you must repurchase):
 *   `combinePrice = (giveX, takeY) => giveX - takeY`.
 *
 * ## Volume semantics
 *
 * Both legs are assumed to be denominated in the **same unit** (the asset being
 * taken/given on both legs). For multi-leg trades crossing through an
 * intermediate asset (e.g. `X->Y->Z`), normalize volumes into the common leg
 * before merging, or extend the combinator to also convert volume.
 *
 * ## Sort order
 *
 * `asSlots()` yields **descending** (best-first). For additive merges of two
 * descending streams, the output is also descending — to build a `HalfBook`
 * (which stores ascending) either feed `asSlotsAscending()` from both inputs,
 * or collect and reverse. For subtractive merges the output order depends on
 * which side is subtracted; verify monotonicity before constructing a book.
 */
export function* seriesMerge<A, B>(
  left: Iterable<Slot<A>>,
  right: Iterable<Slot<B>>,
  combinePrice: (pLeft: number, pRight: number) => number,
): Generator<Slot<SeriesKey<A, B>>, void, undefined> {
  const iterA = left[Symbol.iterator]();
  const iterB = right[Symbol.iterator]();

  let currA = iterA.next();
  let currB = iterB.next();

  let remA = currA.done ? 0 : currA.value.value;
  let remB = currB.done ? 0 : currB.value.value;

  while (!currA.done && !currB.done) {
    const price = combinePrice(currA.value.price, currB.value.price);
    const volume = Math.min(remA, remB);

    yield {
      key: { left: currA.value.key, right: currB.value.key },
      price,
      value: volume,
    };

    remA -= volume;
    remB -= volume;

    // Advance whichever leg was exhausted at this level.
    if (remA <= 0) {
      currA = iterA.next();
      remA = currA.done ? 0 : currA.value.value;
    }
    if (remB <= 0) {
      currB = iterB.next();
      remB = currB.done ? 0 : currB.value.value;
    }
  }
}
