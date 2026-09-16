export interface AgeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly sinceMs: number;
}

export interface AgedSegment {
  readonly lo: number;
  readonly hi: number;
  readonly ageMs: number;
}

/**
 * Piecewise-constant start times for probabilities inside the current spread.
 *
 * Each update intersects the existing tower with the new spread. Retained
 * pieces keep their start time; newly admitted pieces start at `nowMs`.
 */
export class SpreadAge {
  private current: AgeSegment[] = [];
  private lastUpdateMs: number | undefined;

  update(bid: number, ask: number, nowMs: number): void {
    SpreadAge.validateUpdate(bid, ask, nowMs);
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("SpreadAge timestamps must be monotonic");

    const retained: AgeSegment[] = [];
    for (const segment of this.current) {
      const lo = Math.max(segment.lo, bid);
      const hi = Math.min(segment.hi, ask);
      if (lo <= hi) retained.push({ lo, hi, sinceMs: segment.sinceMs });
    }

    const next: AgeSegment[] = [];
    let cursor = bid;

    for (const segment of retained) {
      if (cursor < segment.lo)
        next.push({ lo: cursor, hi: segment.lo, sinceMs: nowMs });
      next.push(segment);
      cursor = Math.max(cursor, segment.hi);
    }

    if (cursor < ask || (next.length === 0 && cursor === ask))
      next.push({ lo: cursor, hi: ask, sinceMs: nowMs });

    this.current = SpreadAge.mergeAdjacent(next);
    this.lastUpdateMs = nowMs;
  }

  segments(nowMs: number): readonly AgedSegment[] {
    if (!Number.isFinite(nowMs))
      throw new RangeError("SpreadAge timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("SpreadAge render time precedes its latest update");

    return this.current.map(({ lo, hi, sinceMs }) => ({
      lo,
      hi,
      ageMs: nowMs - sinceMs,
    }));
  }

  clear(): void {
    this.current = [];
    this.lastUpdateMs = undefined;
  }

  private static validateUpdate(bid: number, ask: number, nowMs: number) {
    if (![bid, ask, nowMs].every(Number.isFinite))
      throw new RangeError("SpreadAge updates must be finite");
    if (bid < 0 || ask > 1 || bid > ask)
      throw new RangeError("SpreadAge requires 0 <= bid <= ask <= 1");
  }

  private static mergeAdjacent(segments: AgeSegment[]): AgeSegment[] {
    const merged: AgeSegment[] = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.hi === segment.lo &&
        previous.sinceMs === segment.sinceMs
      ) {
        merged[merged.length - 1] = { ...previous, hi: segment.hi };
      } else {
        merged.push(segment);
      }
    }
    return merged;
  }
}
