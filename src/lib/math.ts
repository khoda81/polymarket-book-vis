import type { Order } from "./ws";

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

export interface Level {
  price: number;
  depth: number;
}

export interface Step {
  price: number;
  cumulativeDepth: number;
}

export class OrderBook {
  public levels: Level[] = [];

  constructor(bids: Order[] = [], asks: Order[] = []) {
    let depth = 0;
    const bidLevels = bids
      .map(({ price, size }) => ({ price: Number(price), size }))
      .sort((a, b) => b.price - a.price)
      .map(({ price, size }) => ((depth -= size), { price, depth }));

    depth = 0;
    const askLevels = asks
      .map(({ price, size }) => ({ price: Number(price), size }))
      .sort((a, b) => a.price - b.price)
      .map(({ price, size }) => ((depth += size), { price, depth }));

    this.levels = [...bidLevels, ...askLevels];
  }

  /**
   * Dumb storage update: Used for WebSocket sync.
   * Overwrites the absolute depth at a price level. Removes if depth is 0.
   */
  setDepth(price: number, depth: number): void {
    let lo = 0;
    let hi = this.levels.length;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.levels[mid].price < price) lo = mid + 1;
      else hi = mid;
    }

    const exists = lo < this.levels.length && this.levels[lo].price === price;

    if (depth === 0) {
      if (exists) this.levels.splice(lo, 1);
    } else {
      if (exists) {
        this.levels[lo].depth = depth;
      } else {
        this.levels.splice(lo, 0, { price, depth });
      }
    }
  }

  /**
   * Finds the index where the bids end and the asks begin.
   */
  private getSpreadIndex(): number {
    // Binary search to find the first positive depth (ask)
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.levels[mid].depth < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Generates the cumulative curve starting from the spread and moving outward.
   * Yields { price, cumulativeDepth } at each step.
   */
  *sweep(side: "bids" | "asks"): IterableIterator<Step> {
    const spreadIdx = this.getSpreadIndex();
    let currentDepth = 0;

    if (side === "asks") {
      // Walk right (higher prices)
      for (let i = spreadIdx; i < this.levels.length; i++) {
        currentDepth += this.levels[i].depth;
        yield { price: this.levels[i].price, cumulativeDepth: currentDepth };
      }
    } else {
      // Walk left (lower prices)
      for (let i = spreadIdx - 1; i >= 0; i--) {
        currentDepth += this.levels[i].depth; // Accumulating negative values
        yield { price: this.levels[i].price, cumulativeDepth: currentDepth };
      }
    }
  }
}
