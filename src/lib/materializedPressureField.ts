import {
  type PressureBand,
  type PressureBandState,
  type PressureSide,
} from "./pressureField";

export type PressureBookSide = "bid" | "ask";

export interface PressureRenderRun {
  readonly lo: number;
  readonly hi: number;
  readonly bands: readonly PressureBand[];
}

export interface PressureFieldRunSnapshot {
  readonly lo: number;
  readonly hi: number;
  readonly bidVolume: number;
  readonly askVolume: number;
  readonly bidRevision: number;
  readonly askRevision: number;
  readonly bands: readonly PressureBand[];
}

export interface PressureFieldSnapshot {
  readonly revision: number;
  readonly runs: readonly PressureFieldRunSnapshot[];
}

export interface PressureSideDelta {
  readonly price: number;
  readonly delta: number;
}

interface MutableRun {
  lo: number;
  hi: number;
  bidVolume: number;
  askVolume: number;
  bidRevision: number;
  askRevision: number;
  bands: PressureBand[];
}

/**
 * Canonical materialized pressure field over YES price × cumulative volume.
 *
 * Runs partition [0, 1] in canonical price. Each run owns the current
 * cumulative bid/ask volumes plus one disjoint radial semantic shell stack.
 * Level changes mutate only the affected monotone price prefix/suffix, so
 * rendering is a direct read of this structure and never reconstructs history.
 */
export class MaterializedPressureField {
  private runs: MutableRun[] = [emptyRun()];
  private revision = 0;

  renderRuns(): readonly PressureRenderRun[] {
    return this.runs;
  }

  priceBoundaries(): readonly number[] {
    const result = this.runs.map((run) => run.lo);
    result.push(this.runs[this.runs.length - 1]?.hi ?? 1);
    return result;
  }

  shellsAtPrice(price: number): readonly PressureBand[] {
    if (!Number.isFinite(price)) return [];
    const p = clamp01(price);
    let lo = 0;
    let hi = this.runs.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const run = this.runs[mid]!;
      if (p < run.lo) hi = mid;
      else if (p >= run.hi && mid + 1 < this.runs.length) lo = mid + 1;
      else return run.bands;
    }
    return [];
  }

  applySideDeltas(
    side: PressureBookSide,
    deltas: readonly PressureSideDelta[],
    nowMs: number,
  ): void {
    const actual = deltas.filter(
      ({ price, delta }) =>
        Number.isFinite(price) &&
        price >= 0 &&
        price <= 1 &&
        Number.isFinite(delta) &&
        delta !== 0,
    );
    if (actual.length === 0) return;

    for (const { price } of actual) this.splitAt(price);
    const revision = ++this.revision;

    for (const run of this.runs) {
      const midpoint = (run.lo + run.hi) / 2;
      let delta = 0;
      for (const change of actual) {
        if (
          (side === "bid" && midpoint <= change.price) ||
          (side === "ask" && midpoint >= change.price)
        )
          delta += change.delta;
      }
      if (delta === 0) continue;
      transitionRun(run, side, delta, nowMs, revision);
    }

    this.mergeAdjacentRuns();
  }

  pruneGhosts(visibleSinceMs: number): void {
    let changed = false;

    for (const run of this.runs) {
      const next: PressureBand[] = [];
      for (const band of run.bands) {
        if (
          band.state.kind === "ghost" &&
          band.state.sinceMs <= visibleSinceMs
        ) {
          changed = true;
          break;
        }
        next.push(band);
      }
      if (next.length !== run.bands.length) run.bands = next;
    }

    if (changed) this.mergeAdjacentRuns();
  }

  hasGhosts(): boolean {
    return this.runs.some((run) =>
      run.bands.some((band) => band.state.kind === "ghost"),
    );
  }

  hasVisibleGhosts(visibleSinceMs: number): boolean {
    return this.runs.some((run) =>
      run.bands.some(
        (band) =>
          band.state.kind === "ghost" &&
          band.state.sinceMs > visibleSinceMs,
      ),
    );
  }

  ghostBandCount(side?: PressureBookSide): number {
    const pressureSide: PressureSide | null =
      side === undefined ? null : side === "bid" ? 1 : -1;
    let count = 0;
    for (const run of this.runs)
      for (const band of run.bands)
        if (
          band.state.kind === "ghost" &&
          (pressureSide === null || band.side === pressureSide)
        )
          count++;
    return count;
  }

  clear(): void {
    this.runs = [emptyRun()];
    this.revision = 0;
  }

  snapshot(): PressureFieldSnapshot {
    return {
      revision: this.revision,
      runs: this.runs.map((run) => ({
        lo: run.lo,
        hi: run.hi,
        bidVolume: run.bidVolume,
        askVolume: run.askVolume,
        bidRevision: run.bidRevision,
        askRevision: run.askRevision,
        bands: run.bands.map(cloneBand),
      })),
    };
  }

  restore(snapshot: PressureFieldSnapshot): void {
    if (!Number.isFinite(snapshot.revision) || snapshot.revision < 0)
      throw new RangeError("pressure field revision must be non-negative");
    if (!Array.isArray(snapshot.runs) || snapshot.runs.length === 0)
      throw new RangeError("pressure field must contain at least one run");

    const runs = snapshot.runs.map((run) => ({
      lo: finite(run.lo, "run lo"),
      hi: finite(run.hi, "run hi"),
      bidVolume: nonNegative(run.bidVolume, "bid volume"),
      askVolume: nonNegative(run.askVolume, "ask volume"),
      bidRevision: nonNegative(run.bidRevision, "bid revision"),
      askRevision: nonNegative(run.askRevision, "ask revision"),
      bands: run.bands.map(cloneBand),
    }));

    validateRuns(runs);
    this.runs = runs;
    this.revision = snapshot.revision;
    this.mergeAdjacentRuns();
  }

  restoreRuns(
    runs: readonly PressureFieldRunSnapshot[],
    revision = 0,
  ): void {
    this.restore({ revision, runs });
  }

  private splitAt(price: number): void {
    if (!(price > 0 && price < 1)) return;

    for (let index = 0; index < this.runs.length; index++) {
      const run = this.runs[index]!;
      if (price <= run.lo || price >= run.hi) continue;

      const left = cloneRun(run);
      left.hi = price;
      const right = cloneRun(run);
      right.lo = price;
      this.runs.splice(index, 1, left, right);
      return;
    }
  }

  private mergeAdjacentRuns(): void {
    if (this.runs.length < 2) return;

    const merged: MutableRun[] = [];
    for (const run of this.runs) {
      const previous = merged[merged.length - 1];
      if (previous && runsEquivalent(previous, run)) {
        previous.hi = run.hi;
      } else {
        merged.push(run);
      }
    }
    this.runs = merged;
  }
}

function transitionRun(
  run: MutableRun,
  side: PressureBookSide,
  delta: number,
  nowMs: number,
  revision: number,
): void {
  const oldBidVolume = run.bidVolume;
  const oldAskVolume = run.askVolume;
  const oldBidRevision = run.bidRevision;
  const oldAskRevision = run.askRevision;

  if (side === "bid") {
    run.bidVolume = normalizedVolume(run.bidVolume + delta);
    run.bidRevision = revision;
  } else {
    run.askVolume = normalizedVolume(run.askVolume + delta);
    run.askRevision = revision;
  }

  const boundaries = new Set<number>([
    0,
    oldBidVolume,
    oldAskVolume,
    run.bidVolume,
    run.askVolume,
  ]);
  for (const band of run.bands) {
    boundaries.add(band.loVolume);
    boundaries.add(band.hiVolume);
  }
  const sorted = [...boundaries]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  const next: PressureBand[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const lo = sorted[index]!;
    const hi = sorted[index + 1]!;
    if (!(hi > lo)) continue;

    const radius = (lo + hi) / 2;
    const oldOwner = liveOwner(
      oldBidVolume,
      oldAskVolume,
      oldBidRevision,
      oldAskRevision,
      radius,
    );
    const newOwner = liveOwner(
      run.bidVolume,
      run.askVolume,
      run.bidRevision,
      run.askRevision,
      radius,
    );
    const existing = bandAt(run.bands, radius);

    if (newOwner !== null) {
      appendBand(next, {
        loVolume: lo,
        hiVolume: hi,
        side: newOwner,
        state: { kind: "live" },
      });
    } else if (oldOwner !== null) {
      appendBand(next, {
        loVolume: lo,
        hiVolume: hi,
        side: oldOwner,
        state: { kind: "ghost", sinceMs: nowMs },
      });
    } else if (existing) {
      appendBand(next, {
        ...existing,
        loVolume: lo,
        hiVolume: hi,
      });
    }
  }

  run.bands = next;
}

function liveOwner(
  bidVolume: number,
  askVolume: number,
  bidRevision: number,
  askRevision: number,
  radius: number,
): PressureSide | null {
  const bid = radius < bidVolume;
  const ask = radius < askVolume;
  if (!bid && !ask) return null;
  if (bid && !ask) return 1;
  if (ask && !bid) return -1;
  return bidRevision >= askRevision ? 1 : -1;
}

function bandAt(
  bands: readonly PressureBand[],
  radius: number,
): PressureBand | undefined {
  for (const band of bands)
    if (band.loVolume <= radius && radius < band.hiVolume) return band;
  return undefined;
}

function appendBand(bands: PressureBand[], band: PressureBand): void {
  const previous = bands[bands.length - 1];
  if (
    previous &&
    previous.hiVolume === band.loVolume &&
    previous.side === band.side &&
    statesEqual(previous.state, band.state)
  ) {
    bands[bands.length - 1] = {
      ...previous,
      hiVolume: band.hiVolume,
    };
    return;
  }
  bands.push(band);
}

function statesEqual(a: PressureBandState, b: PressureBandState): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "live" || (b.kind === "ghost" && a.sinceMs === b.sinceMs))
  );
}

function runsEquivalent(a: MutableRun, b: MutableRun): boolean {
  return (
    a.hi === b.lo &&
    a.bidVolume === b.bidVolume &&
    a.askVolume === b.askVolume &&
    a.bidRevision === b.bidRevision &&
    a.askRevision === b.askRevision &&
    bandsEqual(a.bands, b.bands)
  );
}

function bandsEqual(
  a: readonly PressureBand[],
  b: readonly PressureBand[],
): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((band, index) => {
        const other = b[index]!;
        return (
          band.loVolume === other.loVolume &&
          band.hiVolume === other.hiVolume &&
          band.side === other.side &&
          statesEqual(band.state, other.state)
        );
      }))
  );
}

function validateRuns(runs: readonly MutableRun[]): void {
  if (runs[0]!.lo !== 0 || runs[runs.length - 1]!.hi !== 1)
    throw new RangeError("pressure runs must cover [0, 1]");

  let previousBid = Number.POSITIVE_INFINITY;
  let previousAsk = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (!(run.hi > run.lo))
      throw new RangeError("pressure run interval must be positive");
    if (index > 0 && runs[index - 1]!.hi !== run.lo)
      throw new RangeError("pressure runs must be contiguous");

    if (run.bidVolume > previousBid)
      throw new RangeError("bid pressure must be non-increasing in price");
    if (run.askVolume < previousAsk)
      throw new RangeError("ask pressure must be non-decreasing in price");
    previousBid = run.bidVolume;
    previousAsk = run.askVolume;

    validateBands(run);
  }
}

function validateBands(run: MutableRun): void {
  let cursor = 0;
  for (const band of run.bands) {
    if (band.loVolume !== cursor || !(band.hiVolume > band.loVolume))
      throw new RangeError("pressure bands must form a contiguous prefix");
    cursor = band.hiVolume;
  }

  const liveExtent = Math.max(run.bidVolume, run.askVolume);
  if (liveExtent > 0 && cursor < liveExtent)
    throw new RangeError("pressure bands must contain all live pressure");

  for (const band of run.bands) {
    const radius = (band.loVolume + band.hiVolume) / 2;
    const owner = liveOwner(
      run.bidVolume,
      run.askVolume,
      run.bidRevision,
      run.askRevision,
      radius,
    );
    if (owner !== null) {
      if (band.state.kind !== "live" || band.side !== owner)
        throw new RangeError("live pressure owner does not match run state");
    } else if (band.state.kind === "live") {
      throw new RangeError("live band exists outside current pressure");
    }
  }
}

function emptyRun(): MutableRun {
  return {
    lo: 0,
    hi: 1,
    bidVolume: 0,
    askVolume: 0,
    bidRevision: 0,
    askRevision: 0,
    bands: [],
  };
}

function cloneRun(run: MutableRun): MutableRun {
  return {
    ...run,
    bands: run.bands.map(cloneBand),
  };
}

function cloneBand(band: PressureBand): PressureBand {
  return {
    ...band,
    state:
      band.state.kind === "live"
        ? { kind: "live" }
        : { kind: "ghost", sinceMs: band.state.sinceMs },
  };
}

function normalizedVolume(value: number): number {
  if (value >= 0) return value;
  if (value > -1e-9) return 0;
  throw new RangeError("pressure cumulative volume became negative");
}

function nonNegative(value: number, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new RangeError(`${label} must be non-negative`);
  return result;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
