import type { TokenBook } from "./orderBook";
import { signedVolumeSegments, type SignedVolumeSegment } from "./signedVolume";

/** Sentinel observation time for regions that have never been observed. */
export const UNKNOWN_SINCE_MS = Number.NEGATIVE_INFINITY;

/** Probability range whose cumulative pressure was observed by one update. */
export interface PressureObservationRange {
  readonly lo: number;
  readonly hi: number;
}

interface HeldVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** Capital required to sweep this pressure; null means legacy/unknown. */
  readonly sweepCost: number | null;
  /** Absolute observation timestamp, or UNKNOWN_SINCE_MS if never observed. */
  readonly observedAtMs: number;
}

interface SnapshotVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** v4 field; null means the economic magnitude was not recorded. */
  readonly sweepCost?: number | null;
  /** v3/v4 field; null is the JSON-safe encoding of UNKNOWN_SINCE_MS. */
  readonly observedAtMs?: number | null;
  /** Legacy v1/v2 field retained only for migration. */
  readonly staleSinceMs?: number | null;
}

export interface StaleSignedVolumeSegment {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
  /** Capital required to sweep this pressure; null means legacy/unknown. */
  readonly sweepCost: number | null;
  /** Infinity means this interval has never been observed. */
  readonly ageMs: number;
}

export interface StaleSignedVolumeSnapshot {
  /** v4 adds sweep cost so magnitude can be derived from Kelly allocation. */
  readonly version?: 2 | 3 | 4;
  readonly lastUpdateMs?: number;
  readonly segments: readonly SnapshotVolumeSegment[];
}

/**
 * Piecewise memory of signed cumulative market pressure.
 *
 * Each interval stores the last pressure observed there, the capital required
 * to sweep it, and when it was observed. There is no separately persisted
 * spread and no live/stale tag.
 *
 * Exact price-change events supply the probability ranges they observe:
 * a bid at q observes [0,q], while an ask at q observes [q,1]. Inside an
 * observed range, present pressure overwrites the remembered value. If the
 * range has just become empty, the previous pressure is retained and stamped
 * with `nowMs`, which is precisely the instant it became stale. Unobserved
 * ranges are left untouched.
 *
 * When `observedRanges` is omitted, the update is a full book snapshot. Such a
 * snapshot refreshes only currently nonzero pressure. Empty regions are left
 * untouched because a snapshot cannot tell us when they became empty.
 */
export class StaleSignedVolume {
  private current: HeldVolumeSegment[] = [];
  /** Exact live field from the immediately previous update. */
  private previousLive: readonly SignedVolumeSegment[] = [];
  private lastUpdateMs: number | undefined;

  update(
    book: TokenBook<unknown>,
    nowMs: number,
    observedRanges?: readonly PressureObservationRange[],
  ): void {
    this.validateTime(nowMs);

    const live = signedVolumeSegments(book);
    const ranges =
      observedRanges === undefined
        ? undefined
        : StaleSignedVolume.normalizeRanges(observedRanges);
    const boundaries = new Set<number>([0, 1]);
    for (const segment of live) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    for (const segment of this.current) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    for (const segment of this.previousLive) {
      boundaries.add(segment.lo);
      boundaries.add(segment.hi);
    }
    for (const range of ranges ?? []) {
      boundaries.add(range.lo);
      boundaries.add(range.hi);
    }

    const sorted = [...boundaries]
      .filter((x) => Number.isFinite(x) && x >= 0 && x <= 1)
      .sort((a, b) => a - b);

    const next: HeldVolumeSegment[] = [];
    let liveIndex = 0;
    let previousLiveIndex = 0;
    let previousIndex = 0;
    let rangeIndex = 0;

    for (let i = 0; i < sorted.length - 1; i++) {
      const lo = sorted[i];
      const hi = sorted[i + 1];
      if (!(hi > lo)) continue;
      const midpoint = (lo + hi) / 2;

      while (liveIndex + 1 < live.length && midpoint >= live[liveIndex].hi)
        liveIndex++;
      while (
        previousLiveIndex + 1 < this.previousLive.length &&
        midpoint >= this.previousLive[previousLiveIndex].hi
      )
        previousLiveIndex++;
      while (
        previousIndex + 1 < this.current.length &&
        midpoint >= this.current[previousIndex].hi
      )
        previousIndex++;
      while (
        ranges &&
        rangeIndex + 1 < ranges.length &&
        midpoint >= ranges[rangeIndex].hi
      )
        rangeIndex++;

      const liveSample = StaleSignedVolume.liveAt(live, liveIndex, midpoint);
      const liveVolume = liveSample?.volume ?? 0;
      const previousLiveSample = StaleSignedVolume.liveAt(
        this.previousLive,
        previousLiveIndex,
        midpoint,
      );
      const previousLiveVolume = previousLiveSample?.volume ?? 0;
      const previous = StaleSignedVolume.segmentAt(
        this.current,
        previousIndex,
        midpoint,
      );
      const observed =
        ranges === undefined
          ? liveVolume !== 0
          : StaleSignedVolume.rangeContains(ranges[rangeIndex], midpoint);

      if (!observed) {
        next.push(StaleSignedVolume.inherit(previous, lo, hi));
        continue;
      }

      if (liveVolume !== 0 && liveSample) {
        next.push({
          lo,
          hi,
          volume: liveVolume,
          sweepCost: liveSample.sweepCost,
          observedAtMs: nowMs,
        });
        continue;
      }

      if (previous && previous.volume !== 0 && previousLiveVolume !== 0) {
        // Stamp only a genuine live→empty transition. Re-observing a range
        // that was already empty must not make its remembered liquidity young
        // again.
        next.push({
          lo,
          hi,
          volume: previous.volume,
          sweepCost: previous.sweepCost,
          observedAtMs: nowMs,
        });
        continue;
      }

      // Zero pressure carries no directional information. Keep an existing
      // zero/unknown sample as-is rather than manufacturing a known zero in the
      // middle of the pipe.
      next.push(StaleSignedVolume.inherit(previous, lo, hi));
    }

    this.current = StaleSignedVolume.mergeAdjacent(next);
    this.previousLive = live;
    this.lastUpdateMs = nowMs;
  }

  segments(nowMs: number): readonly StaleSignedVolumeSegment[] {
    this.validateTime(nowMs);
    return this.current.map(({ lo, hi, volume, sweepCost, observedAtMs }) => ({
      lo,
      hi,
      volume,
      sweepCost,
      ageMs:
        observedAtMs === UNKNOWN_SINCE_MS
          ? Infinity
          : Math.max(0, nowMs - observedAtMs),
    }));
  }

  /** Serialize compact v4 state; unknown timestamps become explicit JSON nulls. */
  snapshot(): StaleSignedVolumeSnapshot {
    return {
      version: 4,
      lastUpdateMs: this.lastUpdateMs,
      segments: this.current.map(({ observedAtMs, ...segment }) => ({
        ...segment,
        observedAtMs: observedAtMs === UNKNOWN_SINCE_MS ? null : observedAtMs,
      })),
    };
  }

  /** Restore v4 snapshots and migrate legacy v1-v3 timestamp fields. */
  restore(snapshot: StaleSignedVolumeSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.segments))
      throw new TypeError("StaleSignedVolume snapshot must contain segments");
    if (
      snapshot.version !== undefined &&
      snapshot.version !== 2 &&
      snapshot.version !== 3 &&
      snapshot.version !== 4
    )
      throw new RangeError("Unsupported StaleSignedVolume snapshot version");
    if (
      snapshot.lastUpdateMs !== undefined &&
      !Number.isFinite(snapshot.lastUpdateMs)
    )
      throw new RangeError("Invalid StaleSignedVolume lastUpdateMs");

    const lastUpdateMs = snapshot.lastUpdateMs;
    const ordered = [...snapshot.segments].sort((a, b) => a.lo - b.lo);
    if (
      ordered.some(
        (segment) =>
          !StaleSignedVolume.validSnapshotSegment(segment, snapshot.version),
      )
    )
      throw new RangeError("Invalid StaleSignedVolume snapshot segment");
    StaleSignedVolume.assertNonOverlapping(ordered);

    const segments = ordered.map((segment) => ({
      lo: segment.lo,
      hi: segment.hi,
      volume: segment.volume,
      sweepCost: snapshot.version === 4 ? (segment.sweepCost ?? null) : null,
      observedAtMs: StaleSignedVolume.snapshotObservedAt(
        segment,
        snapshot.version,
        lastUpdateMs,
      ),
    }));

    this.current = StaleSignedVolume.mergeAdjacent(segments);
    this.previousLive = [];
    this.lastUpdateMs = lastUpdateMs;
  }

  /**
   * Hydrate transport ages onto the caller's local clock. Infinity is the
   * in-memory representation of an explicitly unknown observation time.
   */
  restoreSegments(
    segments: readonly StaleSignedVolumeSegment[],
    nowMs: number,
  ): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");

    const ordered = [...segments].sort((a, b) => a.lo - b.lo);
    if (
      ordered.some(
        (segment) =>
          !(
            segment.ageMs === Infinity ||
            (Number.isFinite(segment.ageMs) && segment.ageMs >= 0)
          ) || !StaleSignedVolume.validTransportSegment(segment),
      )
    )
      throw new RangeError("Invalid StaleSignedVolume transport segment");
    StaleSignedVolume.assertNonOverlapping(ordered);

    this.current = StaleSignedVolume.mergeAdjacent(
      ordered.map(({ lo, hi, volume, sweepCost, ageMs }) => ({
        lo,
        hi,
        volume,
        sweepCost,
        observedAtMs: ageMs === Infinity ? UNKNOWN_SINCE_MS : nowMs - ageMs,
      })),
    );
    this.previousLive = [];
    this.lastUpdateMs = nowMs;
  }

  clear(): void {
    this.current = [];
    this.previousLive = [];
    this.lastUpdateMs = undefined;
  }

  private validateTime(nowMs: number): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("StaleSignedVolume timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("StaleSignedVolume timestamps must be monotonic");
  }

  private static normalizeRanges(
    ranges: readonly PressureObservationRange[],
  ): PressureObservationRange[] {
    const sorted = ranges
      .filter(
        ({ lo, hi }) => Number.isFinite(lo) && Number.isFinite(hi) && hi > lo,
      )
      .map(({ lo, hi }) => ({
        lo: Math.max(0, Math.min(1, lo)),
        hi: Math.max(0, Math.min(1, hi)),
      }))
      .filter(({ lo, hi }) => hi > lo)
      .sort((a, b) => a.lo - b.lo || a.hi - b.hi);

    const merged: PressureObservationRange[] = [];
    for (const range of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && range.lo <= previous.hi) {
        merged[merged.length - 1] = {
          lo: previous.lo,
          hi: Math.max(previous.hi, range.hi),
        };
      } else {
        merged.push(range);
      }
    }
    return merged;
  }

  private static rangeContains(
    range: PressureObservationRange | undefined,
    point: number,
  ): boolean {
    return !!range && point >= range.lo && point < range.hi;
  }

  private static inherit(
    previous: HeldVolumeSegment | undefined,
    lo: number,
    hi: number,
  ): HeldVolumeSegment {
    return previous
      ? {
          lo,
          hi,
          volume: previous.volume,
          sweepCost: previous.sweepCost,
          observedAtMs: previous.observedAtMs,
        }
      : {
          lo,
          hi,
          volume: 0,
          sweepCost: null,
          observedAtMs: UNKNOWN_SINCE_MS,
        };
  }

  private static validGeometry(segment: {
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

  private static validSweepCost(value: unknown): value is number | null {
    return (
      value === null ||
      (typeof value === "number" && Number.isFinite(value) && value >= 0)
    );
  }

  private static validTransportSegment(
    segment: StaleSignedVolumeSegment,
  ): boolean {
    return (
      StaleSignedVolume.validGeometry(segment) &&
      StaleSignedVolume.validSweepCost(segment.sweepCost)
    );
  }

  private static validSnapshotSegment(
    segment: SnapshotVolumeSegment,
    version: StaleSignedVolumeSnapshot["version"],
  ): boolean {
    if (!StaleSignedVolume.validGeometry(segment)) return false;
    if (
      version === 4 &&
      !StaleSignedVolume.validSweepCost(segment.sweepCost ?? null)
    )
      return false;
    const timestamp =
      version === 3 || version === 4
        ? segment.observedAtMs
        : segment.staleSinceMs;
    return (
      timestamp === null ||
      (timestamp !== undefined && Number.isFinite(timestamp))
    );
  }

  private static snapshotObservedAt(
    segment: SnapshotVolumeSegment,
    version: StaleSignedVolumeSnapshot["version"],
    lastUpdateMs: number | undefined,
  ): number {
    if (version === 3 || version === 4)
      return segment.observedAtMs === null
        ? UNKNOWN_SINCE_MS
        : segment.observedAtMs!;

    if (segment.staleSinceMs === null)
      return version === 2
        ? UNKNOWN_SINCE_MS
        : (lastUpdateMs ?? UNKNOWN_SINCE_MS);
    return segment.staleSinceMs!;
  }

  private static liveAt(
    segments: readonly SignedVolumeSegment[],
    index: number,
    point: number,
  ): SignedVolumeSegment | undefined {
    const segment = segments[index];
    return segment && point >= segment.lo && point < segment.hi
      ? segment
      : undefined;
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

  private static assertNonOverlapping(
    segments: readonly { lo: number; hi: number }[],
  ): void {
    for (let i = 1; i < segments.length; i++) {
      if (segments[i]!.lo < segments[i - 1]!.hi)
        throw new RangeError("StaleSignedVolume segments must not overlap");
    }
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
        previous.sweepCost === segment.sweepCost &&
        previous.observedAtMs === segment.observedAtMs
      ) {
        merged[merged.length - 1] = { ...previous, hi: segment.hi };
      } else {
        merged.push(segment);
      }
    }
    return merged;
  }
}
