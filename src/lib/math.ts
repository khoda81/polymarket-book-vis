import type { OrderBook, Order } from "./ws";

export interface Step {
  total: number;
  ratio: number;
}

export function fmtVol(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(0);
}

export function fmtUsd(v: number): string {
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(2) + "k";
  return "$" + v.toFixed(2);
}

/**
 * Compute dynamic Y-axis tick positions as powers of 10.
 * Returns fractions in (0, 1] relative to yMax.
 */
export function powerOf10Ticks(yMax: number, targetCount = 5): number[] {
  if (yMax <= 0) return [];
  const rough = yMax / targetCount;
  const exp = Math.floor(Math.log10(rough));
  const candidates = [1, 2, 5].map((m) => m * Math.pow(10, exp));
  const step = candidates.reduce((best, c) => {
    const n = Math.floor(yMax / c);
    return Math.abs(n - targetCount) <
      Math.abs(Math.floor(yMax / best) - targetCount)
      ? c
      : best;
  });
  const ticks: number[] = [];
  for (let v = step; v <= yMax * 1.001; v += step) ticks.push(v / yMax);
  return ticks;
}

export function hslColor(idx: number): string {
  const hue = (idx * 137.5) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

/**
 * A signed cumulative depth curve stored as two stacks from the spread.
 *
 * `asks` — price ascending from the best ask (index 0 = closest to spread).
 *          Cumulative shares are positive and ascending.
 * `bids` — price descending from the best bid (index 0 = closest to spread).
 *          Cumulative shares are stored as positive absolute values, ascending
 *          from the mid. At render time they're negated to show below zero.
 *
 * This layout makes operations near the spread (the common case) O(1) at the
 * top of each stack, rather than requiring binary search into the middle of a
 * flat array.
 */
export class MarketCurve {
  readonly asks: Step[];
  readonly bids: Step[];

  constructor(asks: Step[], bids: Step[]) {
    this.asks = asks;
    this.bids = bids;
  }

  get length(): number {
    return this.asks.length + this.bids.length;
  }

  /** Price of the best ask, or -Infinity if none. */
  get bestAsk(): number {
    return this.asks.length ? this.asks[0].ratio : -Infinity;
  }

  /** Price of the best bid, or -Infinity if none. */
  get bestBid(): number {
    return this.bids.length ? this.bids[0].ratio : -Infinity;
  }

  /** Midpoint between best ask and best bid. */
  get spreadPrice(): number {
    if (this.asks.length && this.bids.length)
      return (this.bestAsk + this.bestBid) / 2;
    if (this.asks.length) return this.bestAsk;
    if (this.bids.length) return this.bestBid;
    return -Infinity;
  }

  // --- Binary search helpers ---

  /** Find the last index in `arr` where arr[i].key < value. */
  private static findSegment<K extends keyof Step>(
    arr: Step[],
    key: K,
    value: number,
  ): number {
    let lo = 0;
    let hi = arr.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][key] < value) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Find the lower-bound insertion index: first i where arr[i].key >= value. */
  private static lowerBound<K extends keyof Step>(
    arr: Step[],
    key: K,
    value: number,
  ): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][key] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // --- Query methods ---

  /**
   * Signed cumulative shares at a given price.
   * Positive = ask side, negative = bid side, 0 = in the spread.
   */
  totalAtPrice(price: number): number {
    // In the spread: no cumulative volume
    if (price >= this.bestAsk && price <= this.bestBid) return 0;
    // Ask side (price > bestAsk)
    if (price > this.bestAsk && this.asks.length) {
      if (price >= this.asks[this.asks.length - 1].ratio)
        return this.asks[this.asks.length - 1].total;
      const idx = MarketCurve.findSegment(this.asks, "ratio", price);
      return this.asks[idx].total;
    }
    // Bid side (price < bestBid)
    if (price < this.bestBid && this.bids.length) {
      if (price <= this.bids[this.bids.length - 1].ratio)
        return -this.bids[this.bids.length - 1].total;
      const idx = MarketCurve.findSegment(this.bids, "ratio", price);
      return -this.bids[idx].total;
    }
    return 0;
  }

  /** Price of the next step after the given price on the same side, or boundary. */
  nextPriceAfter(price: number): number {
    if (price >= this.bestAsk) {
      const idx = MarketCurve.lowerBound(this.asks, "ratio", price);
      if (idx < this.asks.length && this.asks[idx].ratio > price)
        return this.asks[idx].ratio;
      if (idx + 1 < this.asks.length) return this.asks[idx + 1].ratio;
      return 1;
    }
    if (price <= this.bestBid) {
      const idx = MarketCurve.lowerBound(this.bids, "ratio", price);
      if (idx < this.bids.length && this.bids[idx].ratio > price)
        return this.bids[idx].ratio;
      if (idx + 1 < this.bids.length) return this.bids[idx + 1].ratio;
      return 0;
    }
    // In the spread — snap to the nearer side
    return price - this.bestBid < this.bestAsk - price
      ? this.bestBid
      : this.bestAsk;
  }

  /** Interpolated price at a given signed cumulative-share level. */
  priceAtTotal(total: number): number {
    if (total > 0 && this.asks.length) {
      const idx = MarketCurve.findSegment(this.asks, "total", total);
      const hi = Math.min(idx + 1, this.asks.length - 1);
      const dy = this.asks[hi].total - this.asks[idx].total;
      if (dy === 0) return this.asks[idx].ratio;
      return (
        this.asks[idx].ratio +
        ((total - this.asks[idx].total) / dy) *
          (this.asks[hi].ratio - this.asks[idx].ratio)
      );
    }
    if (total < 0 && this.bids.length) {
      const absTotal = -total;
      const idx = MarketCurve.findSegment(this.bids, "total", absTotal);
      const hi = Math.min(idx + 1, this.bids.length - 1);
      const dy = this.bids[hi].total - this.bids[idx].total;
      if (dy === 0) return this.bids[idx].ratio;
      return (
        this.bids[idx].ratio +
        ((absTotal - this.bids[idx].total) / dy) *
          (this.bids[hi].ratio - this.bids[idx].ratio)
      );
    }
    return this.spreadPrice;
  }

  /**
   * Flatten both stacks into a single sorted Step[] for rendering.
   * Bid totals are negated so they appear below zero on the chart.
   */
  get pts(): Step[] {
    const out: Step[] = [];
    // Bids: stored price-desc, abs-total asc → emit price-asc, negated totals
    for (let i = this.bids.length - 1; i >= 0; i--) {
      out.push({ ratio: this.bids[i].ratio, total: -this.bids[i].total });
    }
    // Asks: already price-asc, positive totals
    out.push(...this.asks);
    return out;
  }

  /**
   * Slice the curve up to a signed cumulative total.
   * Returns a new MarketCurve truncated at that level.
   */
  sliceTo(total: number): MarketCurve {
    if (total >= 0) {
      const out: Step[] = [];
      for (const pt of this.asks) {
        if (pt.total <= total) {
          out.push(pt);
        } else {
          const prev = out[out.length - 1] ?? pt;
          const dy = pt.total - prev.total;
          const t = dy === 0 ? 0 : (total - prev.total) / dy;
          out.push({
            ratio: prev.ratio + t * (pt.ratio - prev.ratio),
            total,
          });
          return new MarketCurve(out, this.bids);
        }
      }
      return new MarketCurve(out, this.bids);
    } else {
      const absTotal = -total;
      const out: Step[] = [];
      for (const pt of this.bids) {
        if (pt.total <= absTotal) {
          out.push(pt);
        } else {
          const prev = out[out.length - 1] ?? pt;
          const dy = pt.total - prev.total;
          const t = dy === 0 ? 0 : (absTotal - prev.total) / dy;
          out.push({
            ratio: prev.ratio + t * (pt.ratio - prev.ratio),
            total: absTotal,
          });
          return new MarketCurve(this.asks, out);
        }
      }
      return new MarketCurve(this.asks, out);
    }
  }

  /**
   * Insert an order into the curve and return a new MarketCurve.
   * @param price Order price
   * @param size  Order size (positive = add liquidity, negative = remove)
   */
  insert(price: number, size: number): MarketCurve {
    if (size === 0) return this;

    if (
      price >= this.bestAsk ||
      (this.asks.length === 0 && price >= this.spreadPrice)
    ) {
      return new MarketCurve(
        this.insertSide(this.asks, price, size),
        this.bids,
      );
    }
    if (
      price <= this.bestBid ||
      (this.bids.length === 0 && price <= this.spreadPrice)
    ) {
      return new MarketCurve(
        this.asks,
        this.insertSide(this.bids, price, size),
      );
    }
    // In the spread — determine side by price position relative to mid
    return price >= this.spreadPrice
      ? new MarketCurve(this.insertSide(this.asks, price, size), this.bids)
      : new MarketCurve(this.asks, this.insertSide(this.bids, price, size));
  }

  /** Insert into one side's stack. */
  private insertSide(side: Step[], price: number, size: number): Step[] {
    if (side.length === 0) {
      return [{ ratio: price, total: Math.abs(size) }];
    }

    const lo = MarketCurve.lowerBound(side, "ratio", price);
    const out = side.slice(0, lo);
    const prevTotal = lo > 0 ? side[lo - 1].total : 0;

    if (lo < side.length && side[lo].ratio === price) {
      for (let i = lo; i < side.length; i++) {
        out.push({ ratio: side[i].ratio, total: side[i].total + size });
      }
    } else {
      out.push({ ratio: price, total: prevTotal + size });
      for (let i = lo; i < side.length; i++) {
        out.push({ ratio: side[i].ratio, total: side[i].total + size });
      }
    }
    return out;
  }
}

/**
 * Build a MarketCurve from a raw order book.
 * Asks are stored price-ascending (best ask at index 0).
 * Bids are stored price-descending (best bid at index 0).
 */
export function buildCurve(book: OrderBook): MarketCurve {
  const asks: Step[] = [];
  let total = 0;
  for (const o of book.asks.toSorted(
    (a: Order, b: Order) => +a.price - +b.price,
  )) {
    total += o.size;
    asks.push({ ratio: +o.price, total });
  }

  const bids: Step[] = [];
  total = 0;
  for (const o of book.bids.toSorted(
    (a: Order, b: Order) => +b.price - +a.price,
  )) {
    total += o.size;
    bids.push({ ratio: +o.price, total });
  }

  return new MarketCurve(asks, bids);
}

/**
 * Compute USD area between two ask-side curves sliced to the same y level.
 * Area = ∫ (xR - xL) dy  (Riemann sum over the staircase segments).
 */
export function calculateArea(sliceL: Step[], sliceR: Step[]): number {
  const ys = [
    ...new Set([...sliceL.map((p) => p.total), ...sliceR.map((p) => p.total)]),
  ].sort((a, b) => a - b);

  function xAtY(curve: Step[], y: number): number | null {
    if (!curve.length) return null;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].total >= y) {
        const dy = curve[i].total - curve[i - 1].total;
        if (dy === 0) return curve[i - 1].ratio;
        return (
          curve[i - 1].ratio +
          ((y - curve[i - 1].total) / dy) *
            (curve[i].ratio - curve[i - 1].ratio)
        );
      }
    }
    return curve[curve.length - 1].ratio;
  }

  let area = 0;
  for (let i = 1; i < ys.length; i++) {
    const yMid = (ys[i - 1] + ys[i]) / 2;
    const xL = xAtY(sliceL, yMid) ?? 0;
    const xR = xAtY(sliceR, yMid) ?? 1;
    area += (xR - xL) * (ys[i] - ys[i - 1]);
  }
  return area;
}
