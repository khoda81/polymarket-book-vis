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

export interface SpreadAgeSnapshot {
  readonly segments: readonly AgeSegment[];
  readonly lastUpdateMs?: number;
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

  snapshot(): SpreadAgeSnapshot {
    return {
      segments: this.current.map((segment) => ({ ...segment })),
      lastUpdateMs: this.lastUpdateMs,
    };
  }

  /** Restore a previously persisted exact state in the same clock domain. */
  restore(snapshot: SpreadAgeSnapshot): void {
    const segments = snapshot.segments.map((segment) => ({ ...segment }));
    let previousHi = -Infinity;
    let previousSince: number | undefined;

    for (const segment of segments) {
      if (![segment.lo, segment.hi, segment.sinceMs].every(Number.isFinite))
        throw new RangeError("SpreadAge snapshot values must be finite");
      if (segment.lo < 0 || segment.hi > 1 || segment.lo > segment.hi)
        throw new RangeError("SpreadAge snapshot requires 0 <= lo <= hi <= 1");
      if (segment.lo < previousHi)
        throw new RangeError("SpreadAge snapshot segments must not overlap");
      if (segment.lo === previousHi && segment.sinceMs === previousSince)
        throw new RangeError("SpreadAge snapshot must be merge-normalized");
      previousHi = segment.hi;
      previousSince = segment.sinceMs;
    }

    if (
      snapshot.lastUpdateMs !== undefined &&
      !Number.isFinite(snapshot.lastUpdateMs)
    )
      throw new RangeError("SpreadAge last update timestamp must be finite");

    this.current = segments;
    this.lastUpdateMs = snapshot.lastUpdateMs;
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
