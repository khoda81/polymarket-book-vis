import { type PressureBand, type PressureSide } from "./pressureField";
import {
  frontierVolumeOnInterval,
  sameFrontierVolume,
  type FrontierRoot,
} from "./monotoneFrontier";
import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";

export type PressureBookSide = "bid" | "ask";

export interface PressureRenderRun {
  readonly lo: Price;
  readonly hi: Price;
  readonly bands: readonly PressureBand[];
}

export interface PressureFieldRunSnapshot {
  readonly lo: Price;
  readonly hi: Price;
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
  readonly price: Price;
  readonly delta: number;
}

interface MutableRun {
  lo: Price;
  hi: Price;
  bidVolume: number;
  askVolume: number;
  bidRevision: number;
  askRevision: number;
  bands: PressureBand[];
}

/**
 * Canonical materialized pressure field over YES price × cumulative volume.
 *
 * Current bid/ask frontiers are computational state. Bands are the rendered
 * observation history: each one records the latest instant through which that
 * pressure was known to be valid. Superseded bands simply stop advancing.
 */
export class MaterializedPressureField {
  private runs: MutableRun[] = [emptyRun()];
  private revision = 0;
  private currentValidThroughMs: number | undefined;

  renderRuns(): readonly PressureRenderRun[] {
    return this.runs.map((run) => ({
      lo: run.lo,
      hi: run.hi,
      bands: materializeBands(run, this.currentValidThroughMs),
    }));
  }

  priceBoundaries(): readonly Price[] {
    const result = this.runs.map((run) => run.lo);
    result.push(this.runs[this.runs.length - 1]?.hi ?? PRICE_ONE);
    return result;
  }

  shellsAtPrice(price: Price): readonly PressureBand[] {
    let lo = 0;
    let hi = this.runs.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const run = this.runs[mid]!;
      if (price < run.lo) hi = mid;
      else if (price >= run.hi && mid + 1 < this.runs.length) lo = mid + 1;
      else return materializeBands(run, this.currentValidThroughMs);
    }
    return [];
  }

  applySideDeltas(
    side: PressureBookSide,
    deltas: readonly PressureSideDelta[],
    validThroughMs: number,
    nextFrontier: FrontierRoot,
  ): void {
    const actual = deltas.filter(
      ({ price, delta }) =>
        Number.isSafeInteger(price) &&
        price >= PRICE_ZERO &&
        price <= PRICE_ONE &&
        Number.isFinite(delta) &&
        delta !== 0,
    );
    if (actual.length === 0) return;

    for (const { price } of actual) this.splitAt(price);
    const revision = ++this.revision;

    for (const run of this.runs) {
      const affected = actual.some(
        (change) =>
          (side === "bid" && run.hi <= change.price) ||
          (side === "ask" && run.lo >= change.price),
      );
      if (!affected) continue;

      const nextVolume = frontierVolumeOnInterval(
        nextFrontier,
        side,
        run.lo,
        run.hi,
      );
      if (nextVolume === (side === "bid" ? run.bidVolume : run.askVolume))
        continue;
      transitionRun(
        run,
        side,
        nextVolume,
        validThroughMs,
        revision,
        this.currentValidThroughMs,
      );
    }

    this.mergeAdjacentRuns();
  }

  /** Advance all current pressure in O(1), without creating history. */
  observeCurrent(validThroughMs: number): void {
    if (!Number.isFinite(validThroughMs))
      throw new RangeError("pressure observation timestamp must be finite");
    this.currentValidThroughMs = validThroughMs;
  }

  hasVisiblePressure(visibleSinceMs: number): boolean {
    return this.runs.some((run) =>
      run.bands.some(
        (band) =>
          effectiveValidThroughMs(run, band, this.currentValidThroughMs) >
          visibleSinceMs,
      ),
    );
  }

  clear(): void {
    this.runs = [emptyRun()];
    this.revision = 0;
    this.currentValidThroughMs = undefined;
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
        bands: materializeBands(run, this.currentValidThroughMs),
      })),
    };
  }

  restore(snapshot: PressureFieldSnapshot): void {
    if (!Number.isFinite(snapshot.revision) || snapshot.revision < 0)
      throw new RangeError("pressure field revision must be non-negative");
    if (!Array.isArray(snapshot.runs) || snapshot.runs.length === 0)
      throw new RangeError("pressure field must contain at least one run");

    const runs = snapshot.runs.map((run) => ({
      lo: priceFromTicks(run.lo),
      hi: priceFromTicks(run.hi),
      bidVolume: nonNegative(run.bidVolume, "bid volume"),
      askVolume: nonNegative(run.askVolume, "ask volume"),
      bidRevision: nonNegative(run.bidRevision, "bid revision"),
      askRevision: nonNegative(run.askRevision, "ask revision"),
      bands: run.bands.map(cloneBand),
    }));

    validateRuns(runs);
    this.runs = runs;
    this.revision = snapshot.revision;
    this.currentValidThroughMs = newestCurrentValidThroughMs(runs);
    this.mergeAdjacentRuns();
  }

  private splitAt(price: Price): void {
    if (!(price > PRICE_ZERO && price < PRICE_ONE)) return;

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
      if (previous && runsEquivalent(previous, run, this.currentValidThroughMs))
        previous.hi = run.hi;
      else merged.push(run);
    }
    this.runs = merged;
  }
}

function transitionRun(
  run: MutableRun,
  side: PressureBookSide,
  nextVolume: number,
  validThroughMs: number,
  revision: number,
  currentValidThroughMs: number | undefined,
): void {
  const oldBidVolume = run.bidVolume;
  const oldAskVolume = run.askVolume;
  const oldBidRevision = run.bidRevision;
  const oldAskRevision = run.askRevision;

  if (side === "bid") {
    run.bidVolume = nextVolume;
    run.bidRevision = revision;
  } else {
    run.askVolume = nextVolume;
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

    const oldOwner = currentOwner(
      oldBidVolume,
      oldAskVolume,
      oldBidRevision,
      oldAskRevision,
      lo,
    );
    const newOwner = currentOwner(
      run.bidVolume,
      run.askVolume,
      run.bidRevision,
      run.askRevision,
      lo,
    );
    const existing = bandAt(run.bands, lo);

    if (newOwner !== null) {
      appendBand(
        next,
        {
          loVolume: lo,
          hiVolume: hi,
          side: newOwner,
          validThroughMs,
        },
        run,
      );
    } else if (oldOwner !== null) {
      appendBand(
        next,
        {
          loVolume: lo,
          hiVolume: hi,
          side: oldOwner,
          validThroughMs:
            existing === undefined
              ? validThroughMs
              : Math.max(
                  existing.validThroughMs,
                  currentValidThroughMs ?? Number.NEGATIVE_INFINITY,
                ),
        },
        run,
      );
    } else if (existing) {
      appendBand(
        next,
        {
          ...existing,
          loVolume: lo,
          hiVolume: hi,
        },
        run,
      );
    }
  }

  run.bands = next;
}

function currentOwner(
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
  return bands.find(
    (band) => band.loVolume <= radius && radius < band.hiVolume,
  );
}

function appendBand(
  bands: PressureBand[],
  band: PressureBand,
  run: MutableRun,
): void {
  const previous = bands[bands.length - 1];
  if (
    previous &&
    previous.hiVolume === band.loVolume &&
    previous.side === band.side &&
    previous.validThroughMs === band.validThroughMs &&
    isCurrent(run, previous.loVolume) === isCurrent(run, band.loVolume)
  ) {
    bands[bands.length - 1] = { ...previous, hiVolume: band.hiVolume };
    return;
  }
  bands.push(band);
}

function isCurrent(run: MutableRun, radius: number): boolean {
  return (
    currentOwner(
      run.bidVolume,
      run.askVolume,
      run.bidRevision,
      run.askRevision,
      radius,
    ) !== null
  );
}

function runsEquivalent(
  a: MutableRun,
  b: MutableRun,
  currentValidThroughMs: number | undefined,
): boolean {
  return (
    a.hi === b.lo &&
    a.bidVolume === b.bidVolume &&
    a.askVolume === b.askVolume &&
    a.bidRevision === b.bidRevision &&
    a.askRevision === b.askRevision &&
    bandsEqual(a, b, currentValidThroughMs)
  );
}

function bandsEqual(
  a: MutableRun,
  b: MutableRun,
  currentValidThroughMs: number | undefined,
): boolean {
  return (
    a.bands === b.bands ||
    (a.bands.length === b.bands.length &&
      a.bands.every((band, index) => {
        const other = b.bands[index]!;
        return (
          band.loVolume === other.loVolume &&
          band.hiVolume === other.hiVolume &&
          band.side === other.side &&
          effectiveValidThroughMs(a, band, currentValidThroughMs) ===
            effectiveValidThroughMs(b, other, currentValidThroughMs)
        );
      }))
  );
}

function materializeBands(
  run: MutableRun,
  currentValidThroughMs: number | undefined,
): PressureBand[] {
  return run.bands.map((band) => ({
    ...band,
    validThroughMs: effectiveValidThroughMs(run, band, currentValidThroughMs),
  }));
}

function effectiveValidThroughMs(
  run: MutableRun,
  band: PressureBand,
  currentValidThroughMs: number | undefined,
): number {
  if (currentValidThroughMs === undefined || !isCurrent(run, band.loVolume))
    return band.validThroughMs;
  return Math.max(band.validThroughMs, currentValidThroughMs);
}

function newestCurrentValidThroughMs(
  runs: readonly MutableRun[],
): number | undefined {
  let newest: number | undefined;
  for (const run of runs) {
    for (const band of run.bands) {
      if (!isCurrent(run, band.loVolume)) continue;
      newest = Math.max(
        newest ?? Number.NEGATIVE_INFINITY,
        band.validThroughMs,
      );
    }
  }
  return newest;
}

function validateRuns(runs: readonly MutableRun[]): void {
  if (runs[0]!.lo !== PRICE_ZERO || runs[runs.length - 1]!.hi !== PRICE_ONE)
    throw new RangeError("pressure runs must cover [0, 1]");

  let previousBid = Number.POSITIVE_INFINITY;
  let previousAsk = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (!(run.hi > run.lo))
      throw new RangeError("pressure run interval must be positive");
    if (index > 0 && runs[index - 1]!.hi !== run.lo)
      throw new RangeError("pressure runs must be contiguous");

    if (
      run.bidVolume > previousBid &&
      !sameFrontierVolume(run.bidVolume, previousBid)
    )
      throw new RangeError("bid pressure must be non-increasing in price");
    if (
      run.askVolume < previousAsk &&
      !sameFrontierVolume(run.askVolume, previousAsk)
    )
      throw new RangeError("ask pressure must be non-decreasing in price");
    previousBid = run.bidVolume;
    previousAsk = run.askVolume;

    validateBands(run);
  }
}

function validateBands(run: MutableRun): void {
  let cursor = 0;
  for (const band of run.bands) {
    if (
      band.loVolume !== cursor ||
      !(band.hiVolume > band.loVolume) ||
      !Number.isFinite(band.validThroughMs)
    )
      throw new RangeError("invalid pressure band");
    cursor = band.hiVolume;
  }

  const currentExtent = Math.max(run.bidVolume, run.askVolume);
  if (currentExtent > 0 && cursor < currentExtent)
    throw new RangeError("pressure bands must contain current pressure");

  for (const band of run.bands) {
    const owner = currentOwner(
      run.bidVolume,
      run.askVolume,
      run.bidRevision,
      run.askRevision,
      band.loVolume,
    );
    if (owner !== null && band.side !== owner)
      throw new RangeError("current pressure owner does not match field");
  }
}

function emptyRun(): MutableRun {
  return {
    lo: PRICE_ZERO,
    hi: PRICE_ONE,
    bidVolume: 0,
    askVolume: 0,
    bidRevision: 0,
    askRevision: 0,
    bands: [],
  };
}

function cloneRun(run: MutableRun): MutableRun {
  return { ...run, bands: run.bands.map(cloneBand) };
}

function cloneBand(band: PressureBand): PressureBand {
  return { ...band };
}

function nonNegative(value: number, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new RangeError(`${label} must be non-negative`);
  return result;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}
