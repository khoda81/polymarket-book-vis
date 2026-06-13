import type { OrderBook, Order } from "./ws";

export interface Step {
  total: number;
  ratio: number;
}

export interface Level {
  price: number;
  size: number;
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
 * An order book stored as two sorted stacks of raw order levels.
 *
 * `bids` — price descending (best/highest bid at index 0, near the spread).
 * `asks` — price ascending (best/lowest ask at index 0, near the spread).
 *
 * Insert mutates in-place. Positive size = bid, negative = ask.
 * Cross-side matching is applied automatically: a bid matches asks at or
 * below its price, an ask matches bids at or above its price.
 */
export class MarketCurve {
  bids: Level[];
  asks: Level[];

  constructor(bids: Level[], asks: Level[]) {
    this.bids = bids;
    this.asks = asks;
  }

  get length(): number {
    return this.bids.length + this.asks.length;
  }

  get bestAsk(): number {
    return this.asks.length ? this.asks[0].price : Infinity;
  }

  get bestBid(): number {
    return this.bids.length ? this.bids[0].price : -Infinity;
  }

  get spreadPrice(): number {
    if (this.asks.length && this.bids.length)
      return (this.bestAsk + this.bestBid) / 2;
    if (this.asks.length) return this.bestAsk;
    if (this.bids.length) return this.bestBid;
    return 0.5;
  }

  /**
   * Insert a signed order in-place.
   * Positive size → bid (left of spread), negative → ask (right of spread).
   * Matches against the opposite side first if the order crosses the spread.
   */
  insert(price: number, size: number): void {
    if (size === 0) return;

    if (size > 0) {
      // Bid: match against asks priced <= this bid
      let remaining = size;
      while (
        remaining > 0 &&
        this.asks.length > 0 &&
        this.asks[0].price <= price
      ) {
        if (this.asks[0].size <= remaining) {
          remaining -= this.asks[0].size;
          this.asks.shift();
        } else {
          this.asks[0].size -= remaining;
          remaining = 0;
        }
      }
      if (remaining > 0) {
        this.addLevel(this.bids, price, remaining);
      }
    } else {
      // Ask: match against bids priced >= this ask
      let remaining = -size;
      while (
        remaining > 0 &&
        this.bids.length > 0 &&
        this.bids[0].price >= price
      ) {
        if (this.bids[0].size <= remaining) {
          remaining -= this.bids[0].size;
          this.bids.shift();
        } else {
          this.bids[0].size -= remaining;
          remaining = 0;
        }
      }
      if (remaining > 0) {
        this.addLevel(this.asks, price, remaining);
      }
    }
  }

  /** Add or merge a level into a sorted side. */
  private addLevel(side: Level[], price: number, size: number): void {
    // bids: price-desc, asks: price-asc — both have best price at index 0
    // We need lower-bound: first index where side[i].price is worse than price
    // For bids (desc): worse = lower price
    // For asks (asc): worse = higher price
    const isBid = side === this.bids;
    let lo = 0;
    let hi = side.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const worse = isBid ? side[mid].price < price : side[mid].price > price;
      if (worse) lo = mid + 1;
      else hi = mid;
    }

    if (lo < side.length && side[lo].price === price) {
      side[lo].size += size;
      if (side[lo].size <= 0) side.splice(lo, 1);
    } else {
      side.splice(lo, 0, { price, size });
    }
  }

  /** Deep clone for temporary preview mutations. */
  clone(): MarketCurve {
    return new MarketCurve(
      this.bids.map((l) => ({ ...l })),
      this.asks.map((l) => ({ ...l })),
    );
  }

  /**
   * Signed cumulative volume at a given price.
   * Positive = ask side, negative = bid side, 0 = in the spread.
   */
  totalAtPrice(price: number): number {
    if (this.asks.length && price >= this.bestAsk) {
      let total = 0;
      for (const level of this.asks) {
        if (level.price > price) break;
        total += level.size;
      }
      return total;
    }
    if (this.bids.length && price <= this.bestBid) {
      let total = 0;
      for (const level of this.bids) {
        if (level.price < price) break;
        total += level.size;
      }
      return -total;
    }
    return 0;
  }

  /** Interpolated price at a given signed cumulative level. */
  priceAtTotal(total: number): number {
    if (total === 0) return this.spreadPrice;
    const steps = this.pts;
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const curr = steps[i];
      if (
        (prev.total <= total && total <= curr.total) ||
        (prev.total >= total && total >= curr.total)
      ) {
        const d = curr.total - prev.total;
        if (d === 0) return prev.ratio;
        const t = (total - prev.total) / d;
        return prev.ratio + t * (curr.ratio - prev.ratio);
      }
    }
    return steps.length ? steps[steps.length - 1].ratio : this.spreadPrice;
  }

  /**
   * Build cumulative Step[] for rendering.
   * Bid totals are negated so they appear below zero on the chart.
   */
  get pts(): Step[] {
    const out: Step[] = [];
    // Bids: stored price-desc → emit price-asc, negative cumulative
    let cum = 0;
    for (let i = this.bids.length - 1; i >= 0; i--) {
      cum += this.bids[i].size;
      out.push({ ratio: this.bids[i].price, total: -cum });
    }
    // Asks: stored price-asc, positive cumulative
    cum = 0;
    for (const level of this.asks) {
      cum += level.size;
      out.push({ ratio: level.price, total: cum });
    }
    return out;
  }
}

/**
 * Build a MarketCurve from a raw order book.
 * Bids are stored price-descending (best bid at index 0).
 * Asks are stored price-ascending (best ask at index 0).
 */
export function buildCurve(book: OrderBook): MarketCurve {
  const asks: Level[] = book.asks
    .toSorted((a: Order, b: Order) => +a.price - +b.price)
    .map((o) => ({ price: +o.price, size: o.size }));
  const bids: Level[] = book.bids
    .toSorted((a: Order, b: Order) => +b.price - +a.price)
    .map((o) => ({ price: +o.price, size: o.size }));
  return new MarketCurve(bids, asks);
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
