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
  /** Amount of take (the token the order receives). `give = price * take`. */
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
 * Represents a single "wing" (one side) of a limit order book.
 * By design, this data structure is asymmetrical and maintains only a single,
 * strictly sorted list of orders. To represent a complete order book, you must
 * instantiate two of these classes (e.g., one wing giving the priced token,
 * one wing giving the pricing token).
 *
 * ## Representation choice: `{ price, take }` over `{ price, give }`
 *
 * An order is fundamentally two deltas with a ratio. Any two of
 * `{price, give, take}` suffice (price = give/take). We store `price` and
 * `take`, deriving `give = price * take` by **multiplication**.
 *
 * The alternative `{price, give}` would derive `take = give / price` by
 * **division**, which is strictly worse at the IEEE-754 boundary corners:
 *
 * | corner `{price, value}` | `value/price` (division) | `price*value` (multiplication) |
 * |---|---|---|
 * | `{∞, ∞}` | `∞/∞ = NaN` ❌ | `∞·∞ = ∞` ✅ |
 * | `{0, 0}` | `0/0 = NaN` | `0·0 = 0` ✅ |
 * | `{0, ∞}` | `∞/0 = ∞` | `0·∞ = NaN` ❌ |
 * | `{∞, 0}` | `0/∞ = 0` | `∞·0 = NaN` ❌ |
 *
 * `setLevel` never stores `price <= 0` or `take <= 0`, which excludes exactly
 * the rows where multiplication goes NaN (`{0,*}` and `{*,0}`). The surviving
 * space `price ∈ (0, ∞], take ∈ (0, ∞]` has **zero NaN-producing corners**
 * under multiplication. The same filters do *not* rescue division, which is
 * ill-behaved off-axis at `{∞, ∞}` — a corner the filters don't touch.
 *
 * Performance aligns with this choice: the render hot path (`drawBookView`)
 * and the inversion (`asSellOrders`) both need `take` directly, so storing it
 * eliminates a per-row division. The one operation that needs `give`
 * (`takeBest`, denominated in give to keep the sink on the give side) lives in
 * the merge path, which is colder.
 *
 * ## The sink: free disposal, not free minting
 *
 * An empty book behaves as a **price-0 sink on the give side**: you can always
 * dispose of any token for nothing (free disposal is a physical universal).
 * This is *not* symmetric — you cannot generally mint any token at price 0.
 * Infinite minting is an institutional fiction that exists only for specific
 * tokens (e.g. Polymarket's USDC→YES+NO mint at price 1, modeled as a real
 * stored level, not as the sink). The sink is never stored; it is the
 * implicit behavior of `takeBest` on an empty book.
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
   * Insert or replace an order. If the key already exists, it is removed first.
   *
   * Rejects `price <= 0`. A `price` of 0 is the sink, which is never stored —
   * it's the implicit behavior of an empty book. A `take <= 0` update removes
   * an existing level, matching aggregate order-book delta semantics.
   *
   * @returns `true` if the order key existed. Otherwise, `false`.
   */
  setLevel(key: OrderKey, order: BookOrder): boolean {
    if (order.price <= 0) return false;
    if (order.take <= 0) return this.removeOrder(key);

    const existing = this.index.get(key);

    if (existing) {
      if (existing.price === order.price)
        return this.updateTake(key, order.take);
      console.warn(
        `Modifying price of an existing order: `,
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
   * Update the take amount of an existing order. `take <= 0` removes the order.
   */
  updateTake(key: OrderKey, take: number): boolean {
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

  /**
   * Returns the order for `key`, or a price-0 sink phantom (`take: 1`) when
   * absent. The phantom is never stored — it represents the implicit
   * free-disposal sink (see class doc). `take: 1` is arbitrary since the sink
   * has infinite capacity; it only exists so callers reading a missing key
   * get a well-defined `give = price * take = 0`.
   */
  getOrder(key: OrderKey): BookOrder {
    return this.index.get(key) ?? { price: 0, take: 1 };
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
   * Consume up to `giveLimit` units of **give** from the best (highest-priced)
   * order. Returns the fill priced in take-per-give, with `consumed` in **give**
   * units (so `takeReceived = consumed * price`).
   *
   * `giveLimit` is denominated in give (not take) so that the sink semantics
   * stay on the give side: an empty book returns `{ price: 0, consumed: giveLimit }`,
   * meaning "you disposed of `giveLimit` for nothing" — free disposal, not free
   * minting. See the class doc for why the sink must live on the give side.
   *
   * Because the book stores `take` and `giveLimit` is in give, this method
   * divides once (`giveLimit / price`) to convert the budget into take units.
   * This is the one place the `{price, take}` representation pays a division;
   * it lives in the merge path (colder than the render hot path).
   */
  takeBest(giveLimit: number): { price: number; consumed: number } {
    if (this.orders.length === 0) return { price: 0, consumed: giveLimit };

    const key = this.orders[this.orders.length - 1];
    const order = this.index.get(key)!;
    const takeToConsume = Math.min(order.take, giveLimit / order.price);
    const giveConsumed = takeToConsume * order.price;

    if (takeToConsume >= order.take) this.removeOrder(key);
    else order.take -= takeToConsume;

    return { price: order.price, consumed: giveConsumed };
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
   * new take token and vice versa. New price = 1/old.price (give-per-take
   * becomes take-per-give); new take = old.give = old.price * old.take.
   *
   * This is the headline win of storing `{price, take}`: the inversion is a
   * **multiplication** (`price * take`), which is total at every valid corner.
   * Under the old `{price, give}` representation this was a division
   * (`give / price`), which produced NaN at `{∞, ∞}`.
   */
  *asSellOrders() {
    for (const order of this.asOrders()) {
      if (order.price <= 0) break;

      // New price: the inverse ratio.
      const price = 1 / order.price;

      // New take = old give = price * take (multiplication, never NaN).
      const take = order.price * order.take;

      yield { price, take };
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
    for (const { key, price, take } of slots) {
      book.orders.push(key);
      book.index.set(key, { price, take });
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
   * books are left untouched. The loop guard checks `a.size > 0 || b.size > 0`
   * before any `takeBest` call, so `takeBest` never sees an empty book and the
   * price-0 sink never fires here — all recorded fills come from real liquidity.
   *
   * `takeBest` is denominated in give, so `remaining` and `fill.consumed` are
   * in give units; the resulting merged orders store `take = consumed * price`.
   *
   * @param limit Optional cap on total **give** volume to simulate. Defaults to
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
      // Both books are non-empty here (loop guard), so both tops exist.
      const takeFromA = topA!.price <= topB!.price;
      const source = takeFromA ? a : b;
      const top = takeFromA ? topA! : topB!;

      const fill = source.takeBest(remaining);

      const key = top.key as unknown as A | B;
      const tag: MergedKey<A, B> = takeFromA
        ? { source: "left", key: key as A }
        : { source: "right", key: key as B };

      // `takeBest` returns `consumed` in give units; convert to take for storage.
      merged.push({
        key: tag,
        price: fill.price,
        take: fill.consumed * fill.price,
      });
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
 * Both legs are assumed to be denominated in the **same unit** (the take
 * amount, since `Slot.take` is what `seriesMerge` bottlenecks on). For
 * multi-leg trades crossing through an intermediate asset (e.g. `X->Y->Z`),
 * normalize volumes into the common leg before merging, or extend the
 * combinator to also convert volume.
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

  let remA = currA.done ? 0 : currA.value.take;
  let remB = currB.done ? 0 : currB.value.take;

  while (!currA.done && !currB.done) {
    const price = combinePrice(currA.value.price, currB.value.price);
    const volume = Math.min(remA, remB);

    yield {
      key: { left: currA.value.key, right: currB.value.key },
      price,
      take: volume,
    };

    remA -= volume;
    remB -= volume;

    // Advance whichever leg was exhausted at this level.
    if (remA <= 0) {
      currA = iterA.next();
      remA = currA.done ? 0 : currA.value.take;
    }
    if (remB <= 0) {
      currB = iterB.next();
      remB = currB.done ? 0 : currB.value.take;
    }
  }
}
