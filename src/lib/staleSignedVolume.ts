import { canonicalSpread, type TokenBook } from "./orderBook";
import {
  signedVolumeSegments,
  type SignedVolumeSegment,
} from "./signedVolume";

interface HeldVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** null while the current order book constrains this price. */
  readonly staleSinceMs: number | null;
}

export interface StaleSignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** Zero for live book state; positive only while the price is in the spread. */
  readonly ageMs: number;
}

/**
 * Sample-and-hold extension of the current signed cumulative volume field.
 *
 * Outside the spread, the field is always overwritten by the live order book
 * and has age zero. When a region enters the spread, its most recent live
 * signed volume is frozen and the stale clock starts. If a price later leaves
 * the spread, live order-book state immediately replaces the frozen value.
 */
export class StaleSignedVolume {
  private current: HeldVolumeSegment[] = [];
  private lastUpdateMs: number | undefined;

  update(book: TokenBook<unknown>, nowMs: number): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("StaleSignedVolume timestamps must be monotonic");

    const live = signedVolumeSegments(book);
    const { bid, ask } = canonicalSpread(book);
    const boundaries = new Set<number>([0, 1, bid, ask]);
    for (const segment of live) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    for (const segment of this.current) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }

    const sorted = [...boundaries]
      .filter((x) => Number.isFinite(x) && x >= 0 && x <= 1)
      .sort((a, b) => a - b);

    const next: HeldVolumeSegment[] = [];
    let liveIndex = 0;
    let previousIndex = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const lo = sorted[i];
      const hi = sorted[i + 1];
      if (!(hi > lo)) continue;
      const midpoint = (lo + hi) / 2;

      while (liveIndex + 1 < live.length && midpoint >= live[liveIndex].hi)
        liveIndex++;
      while (
        previousIndex + 1 < this.current.length &&
        midpoint >= this.current[previousIndex].hi
      )
        previousIndex++;

      const liveVolume = StaleSignedVolume.volumeAt(
        live,
        liveIndex,
        midpoint,
      );
      const previous = StaleSignedVolume.segmentAt(
        this.current,
        previousIndex,
        midpoint,
      );
      const insideSpread = midpoint > bid && midpoint < ask;

      if (!insideSpread) {
        next.push({ lo, hi, volume: liveVolume, staleSinceMs: null });
      } else if (previous && previous.staleSinceMs !== null) {
        next.push({
          lo,
          hi,
          volume: previous.volume,
          staleSinceMs: previous.staleSinceMs,
        });
      } else {
        next.push({
          lo,
          hi,
          volume: previous?.volume ?? 0,
          staleSinceMs: nowMs,
        });
      }
    }

    this.current = StaleSignedVolume.mergeAdjacent(next);
    this.lastUpdateMs = nowMs;
  }

  segments(nowMs: number): readonly StaleSignedVolumeSegment[] {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError(
        "StaleSignedVolume render time precedes its latest update",
      );

    return this.current.map(({ lo, hi, volume, staleSinceMs }) => ({
      lo,
      hi,
      volume,
      ageMs: staleSinceMs === null ? 0 : nowMs - staleSinceMs,
    }));
  }

  clear(): void {
    this.current = [];
    this.lastUpdateMs = undefined;
  }

  private static volumeAt(
    segments: readonly SignedVolumeSegment[],
    index: number,
    point: number,
  ): number {
    const segment = segments[index];
    return segment && point >= segment.lo && point < segment.hi
      ? segment.volume
      : 0;
  }

  private static segmentAt(
    segments: readonly HeldVolumeSegment[],
    index: number,
    point: number,
  ): HeldVolumeSegment | undefined {
    const segment = segments[index];
    return segment && point >= segment.lo && point < segment.hi
      ? segment
      : undefined;
  }

  private static mergeAdjacent(
    segments: readonly HeldVolumeSegment[],
  ): HeldVolumeSegment[] {
    const merged: HeldVolumeSegment[] = [];
    for (const segment of segments) {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        previous.hi === segment.lo &&
        previous.volume === segment.volume &&
        previous.staleSinceMs === segment.staleSinceMs
      ) {
        merged[merged.length - 1] = { ...previous, hi: segment.hi };
      } else {
        merged.push(segment);
      }
    }
    return merged;
  }
}
