import { canonicalSpread, type TokenBook } from "./orderBook";
import {
  signedVolumeSegments,
  type SignedVolumeSegment,
} from "./signedVolume";

/** Sentinel observation time for regions that have never been observed. */
export const UNKNOWN_SINCE_MS = Number.NEGATIVE_INFINITY;

export interface StaleSignedVolumeSpread {
  readonly bid: number;
  readonly ask: number;
}

interface HeldVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** Absolute observation timestamp, or UNKNOWN_SINCE_MS if never observed. */
  readonly staleSinceMs: number;
}

interface SnapshotVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** null is the JSON-safe encoding of UNKNOWN_SINCE_MS in v2 snapshots. */
  readonly staleSinceMs: number | null;
}

export interface StaleSignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** Infinity means this interval has never been observed. */
  readonly ageMs: number;
}

export interface StaleSignedVolumeSnapshot {
  /** Missing means the legacy v1 segment semantics where null meant live. */
  readonly version?: 2;
  readonly lastUpdateMs?: number;
  readonly spread?: StaleSignedVolumeSpread;
  readonly segments: readonly SnapshotVolumeSegment[];
}

/**
 * Sample-and-hold extension of the current signed cumulative volume field.
 *
 * There is deliberately no live/stale tagged state. Every interval carries the
 * timestamp of its latest observation. Constrained intervals are refreshed to
 * `nowMs`; intervals that enter the spread freeze at the transition time;
 * intervals already in the spread retain their timestamp. A never-observed
 * interval uses UNKNOWN_SINCE_MS, which renders as age Infinity.
 */
export class StaleSignedVolume {
  private current: HeldVolumeSegment[] = [];
  private lastUpdateMs: number | undefined;
  private lastSpread: StaleSignedVolumeSpread | undefined;

  update(book: TokenBook<unknown>, nowMs: number): void {
    this.validateTime(nowMs);

    const live = signedVolumeSegments(book);
    const spread = canonicalSpread(book);
    const boundaries = new Set<number>([0, 1, spread.bid, spread.ask]);
    for (const segment of live) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    for (const segment of this.current) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    if (this.lastSpread) {
      boundaries.add(this.lastSpread.bid);
      boundaries.add(this.lastSpread.ask);
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
      const insideSpread = midpoint > spread.bid && midpoint < spread.ask;

      if (!insideSpread) {
        // Current book pressure is observable here right now.
        next.push({ lo, hi, volume: liveVolume, staleSinceMs: nowMs });
        continue;
      }

      if (!previous) {
        // The first snapshot cannot tell us what existed in its spread before
        // recording began. Zero would be a fabricated observation here.
        next.push({ lo, hi, volume: 0, staleSinceMs: UNKNOWN_SINCE_MS });
        continue;
      }

      const wasInsidePreviousSpread = this.lastSpread
        ? midpoint > this.lastSpread.bid && midpoint < this.lastSpread.ask
        : previous.staleSinceMs !== this.lastUpdateMs;

      if (wasInsidePreviousSpread) {
        next.push({
          lo,
          hi,
          volume: previous.volume,
          staleSinceMs: previous.staleSinceMs,
        });
      } else {
        // It was constrained up to this update and has just entered the spread.
        next.push({
          lo,
          hi,
          volume: previous.volume,
          staleSinceMs: nowMs,
        });
      }
    }

    this.current = StaleSignedVolume.mergeAdjacent(next);
    this.lastUpdateMs = nowMs;
    this.lastSpread = spread;
  }

  segments(nowMs: number): readonly StaleSignedVolumeSegment[] {
    this.validateTime(nowMs);
    return this.current.map(({ lo, hi, volume, staleSinceMs }) => ({
      lo,
      hi,
      volume,
      ageMs:
        staleSinceMs === UNKNOWN_SINCE_MS
          ? Infinity
          : Math.max(0, nowMs - staleSinceMs),
    }));
  }

  spread(): StaleSignedVolumeSpread | undefined {
    return this.lastSpread ? { ...this.lastSpread } : undefined;
  }

  /** Serialize compact state; unknown timestamps become explicit JSON nulls. */
  snapshot(): StaleSignedVolumeSnapshot {
    return {
      version: 2,
      lastUpdateMs: this.lastUpdateMs,
      spread: this.lastSpread ? { ...this.lastSpread } : undefined,
      segments: this.current.map(({ staleSinceMs, ...segment }) => ({
        ...segment,
        staleSinceMs:
          staleSinceMs === UNKNOWN_SINCE_MS ? null : staleSinceMs,
      })),
    };
  }

  /** Restore v2 snapshots and migrate legacy snapshots where null meant live. */
  restore(snapshot: StaleSignedVolumeSnapshot): void {
    const lastUpdateMs =
      snapshot.lastUpdateMs !== undefined && Number.isFinite(snapshot.lastUpdateMs)
        ? snapshot.lastUpdateMs
        : undefined;
    const isV2 = snapshot.version === 2;

    const segments = snapshot.segments
      .filter(StaleSignedVolume.validSnapshotSegment)
      .sort((a, b) => a.lo - b.lo)
      .map(({ staleSinceMs, ...segment }) => ({
        ...segment,
        staleSinceMs:
          staleSinceMs === null
            ? isV2
              ? UNKNOWN_SINCE_MS
              : lastUpdateMs ?? UNKNOWN_SINCE_MS
            : staleSinceMs,
      }));

    this.current = StaleSignedVolume.mergeAdjacent(segments);
    this.lastUpdateMs = lastUpdateMs;
    this.lastSpread = StaleSignedVolume.validSpread(snapshot.spread)
      ? { ...snapshot.spread }
      : undefined;
  }

  /**
   * Hydrate transport ages onto the caller's local clock. Infinity is the
   * in-memory representation of an explicitly unknown observation time.
   */
  restoreSegments(
    segments: readonly StaleSignedVolumeSegment[],
    nowMs: number,
    spread?: StaleSignedVolumeSpread,
  ): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");

    this.current = StaleSignedVolume.mergeAdjacent(
      segments
        .filter(
          (segment) =>
            (segment.ageMs === Infinity ||
              (Number.isFinite(segment.ageMs) && segment.ageMs >= 0)) &&
            StaleSignedVolume.validRange(segment),
        )
        .sort((a, b) => a.lo - b.lo)
        .map(({ lo, hi, volume, ageMs }) => ({
          lo,
          hi,
          volume,
          staleSinceMs:
            ageMs === Infinity ? UNKNOWN_SINCE_MS : nowMs - ageMs,
        })),
    );
    this.lastUpdateMs = nowMs;
    this.lastSpread = StaleSignedVolume.validSpread(spread)
      ? { ...spread }
      : undefined;
  }

  clear(): void {
    this.current = [];
    this.lastUpdateMs = undefined;
    this.lastSpread = undefined;
  }

  private validateTime(nowMs: number): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("StaleSignedVolume timestamps must be monotonic");
  }

  private static validRange(segment: {
    lo: number;
    hi: number;
    volume: number;
  }): boolean {
    return (
      Number.isFinite(segment.lo) &&
      Number.isFinite(segment.hi) &&
      !Number.isNaN(segment.volume) &&
      segment.lo >= 0 &&
      segment.hi <= 1 &&
      segment.hi > segment.lo
    );
  }

  private static validSpread(
    spread: StaleSignedVolumeSpread | undefined,
  ): spread is StaleSignedVolumeSpread {
    return !!spread &&
      Number.isFinite(spread.bid) &&
      Number.isFinite(spread.ask) &&
      spread.bid >= 0 &&
      spread.ask <= 1 &&
      spread.ask >= spread.bid;
  }

  private static validSnapshotSegment(
    segment: SnapshotVolumeSegment,
  ): boolean {
    return (
      StaleSignedVolume.validRange(segment) &&
      (segment.staleSinceMs === null || Number.isFinite(segment.staleSinceMs))
    );
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
