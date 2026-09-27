import {
  frontierVolumeThrough,
  sameFrontierVolume,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "./pressureField";
import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";

export interface PressureRenderRun {
  readonly lo: Price;
  readonly hi: Price;
  /** Current cumulative resting volume for this price run. */
  readonly volume: number;
  /** Stored historical bands; current validity is applied lazily by consumers. */
  readonly bands: readonly PressureBand[];
}

export interface PressureFieldRunSnapshot {
  readonly lo: Price;
  readonly hi: Price;
  readonly volume: number;
  readonly bands: readonly PressureBand[];
}

export interface PressureFieldSnapshot {
  readonly currentValidThroughMs: number | null;
  readonly runs: readonly PressureFieldRunSnapshot[];
}

export interface PressureLevelDelta {
  readonly price: Price;
  readonly delta: number;
}

interface MutableRun {
  lo: Price;
  hi: Price;
  volume: number;
  bands: PressureBand[];
}

/**
 * Historical pressure for one directed token -> collateral edge.
 *
 * Price coordinates are edge-local. A resting level at price p contributes to
 * cumulative pressure for every x >= p, so volume is monotone non-decreasing
 * across price. The field has no knowledge of YES/NO, bid/ask, or screen side.
 */
export class MaterializedPressureField {
  private runs: MutableRun[] = [emptyRun()];
  private currentValidThroughMs: number | undefined;

  renderRuns(): readonly PressureRenderRun[] {
    // MutableRun is structurally compatible with the readonly render view.
    // Do not clone/materialize historical bands here: render-only decay frames
    // are extremely frequent and the renderer can apply current validity lazily.
    return this.runs;
  }

  renderCurrentValidThroughMs(): number | undefined {
    return this.currentValidThroughMs;
  }

  priceBoundaries(): readonly Price[] {
    const result = this.runs.map((run) => run.lo);
    result.push(this.runs[this.runs.length - 1]?.hi ?? PRICE_ONE);
    return result;
  }

  bandsAtPrice(price: Price): readonly PressureBand[] {
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

  applyDeltas(
    deltas: readonly PressureLevelDelta[],
    validThroughMs: number,
    nextFrontier: FrontierRoot,
  ): void {
    const actual = validDeltas(deltas);
    if (actual.length === 0) return;

    for (const { price } of actual) this.splitAt(price);

    for (const run of this.runs) {
      if (!actual.some(({ price }) => run.lo >= price)) continue;

      const nextVolume = frontierVolumeThrough(nextFrontier, run.lo);
      if (sameFrontierVolume(nextVolume, run.volume)) continue;

      transitionRun(
        run,
        nextVolume,
        validThroughMs,
        this.currentValidThroughMs,
      );
    }

    this.mergeAdjacentRuns();
  }

  /** Advance all currently resting pressure in O(1), without creating history. */
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
    this.currentValidThroughMs = undefined;
  }

  snapshot(): PressureFieldSnapshot {
    return {
      currentValidThroughMs: this.currentValidThroughMs ?? null,
      runs: this.runs.map((run) => ({
        lo: run.lo,
        hi: run.hi,
        volume: run.volume,
        bands: materializeBands(run, this.currentValidThroughMs),
      })),
    };
  }

  restore(snapshot: PressureFieldSnapshot): void {
    const currentValidThroughMs =
      snapshot.currentValidThroughMs === null
        ? undefined
        : finite(snapshot.currentValidThroughMs, "current valid-through");
    if (!Array.isArray(snapshot.runs) || snapshot.runs.length === 0)
      throw new RangeError("pressure field must contain at least one run");

    const runs = snapshot.runs.map((run) => ({
      lo: priceFromTicks(run.lo),
      hi: priceFromTicks(run.hi),
      volume: nonNegative(run.volume, "pressure volume"),
      bands: run.bands.map(cloneBand),
    }));

    validateRuns(runs);
    this.runs = runs;
    this.currentValidThroughMs = currentValidThroughMs;
    this.mergeAdjacentRuns();
  }

  validateAgainstFrontier(frontier: FrontierRoot): void {
    const boundaries = new Set<Price>();
    for (const run of this.runs) {
      boundaries.add(run.lo);
      boundaries.add(run.hi);
      const expected = frontierVolumeThrough(frontier, run.lo);
      if (!sameFrontierVolume(run.volume, expected))
        throw new RangeError(
          "materialized pressure field does not match current frontier",
        );
    }
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
      if (
        previous &&
        previous.hi === run.lo &&
        sameFrontierVolume(previous.volume, run.volume) &&
        bandsEqual(previous, run, this.currentValidThroughMs)
      )
        previous.hi = run.hi;
      else merged.push(run);
    }
    this.runs = merged;
  }
}

function validDeltas(
  deltas: readonly PressureLevelDelta[],
): PressureLevelDelta[] {
  return deltas.filter(
    ({ price, delta }) =>
      Number.isSafeInteger(price) &&
      price >= PRICE_ZERO &&
      price <= PRICE_ONE &&
      Number.isFinite(delta) &&
      delta !== 0,
  );
}

function transitionRun(
  run: MutableRun,
  nextVolume: number,
  validThroughMs: number,
  currentValidThroughMs: number | undefined,
): void {
  const oldVolume = run.volume;
  run.volume = nextVolume;

  const boundaries = new Set<number>([0, oldVolume, nextVolume]);
  for (const band of run.bands) {
    boundaries.add(band.loVolume);
    boundaries.add(band.hiVolume);
  }

  const sorted = [...boundaries]
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  const next: PressureBand[] = [];
  let bandIndex = 0;
  for (let index = 0; index + 1 < sorted.length; index++) {
    const lo = sorted[index]!;
    const hi = sorted[index + 1]!;
    if (!(hi > lo)) continue;

    // Both the generated intervals and stored bands are ordered by volume.
    // Walk the bands once instead of rescanning from the beginning for every
    // interval (the old bandAt/find path was O(B²)).
    while (bandIndex < run.bands.length && run.bands[bandIndex]!.hiVolume <= lo)
      bandIndex++;

    const candidate = run.bands[bandIndex];
    const existing =
      candidate && candidate.loVolume <= lo && lo < candidate.hiVolume
        ? candidate
        : undefined;

    const wasCurrent = lo < oldVolume;
    const isCurrent = lo < nextVolume;

    if (isCurrent) {
      appendBand(next, {
        loVolume: lo,
        hiVolume: hi,
        validThroughMs,
      });
    } else if (wasCurrent) {
      appendBand(next, {
        loVolume: lo,
        hiVolume: hi,
        validThroughMs: Math.max(
          existing?.validThroughMs ?? Number.NEGATIVE_INFINITY,
          currentValidThroughMs ?? Number.NEGATIVE_INFINITY,
        ),
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

function appendBand(bands: PressureBand[], band: PressureBand): void {
  if (!Number.isFinite(band.validThroughMs)) return;

  const previous = bands[bands.length - 1];
  if (
    previous &&
    previous.hiVolume === band.loVolume &&
    previous.validThroughMs === band.validThroughMs
  ) {
    bands[bands.length - 1] = { ...previous, hiVolume: band.hiVolume };
    return;
  }
  bands.push(band);
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
  if (currentValidThroughMs === undefined || !(band.loVolume < run.volume))
    return band.validThroughMs;
  return Math.max(band.validThroughMs, currentValidThroughMs);
}

function validateRuns(runs: readonly MutableRun[]): void {
  if (runs[0]!.lo !== PRICE_ZERO || runs[runs.length - 1]!.hi !== PRICE_ONE)
    throw new RangeError("pressure runs must cover [0, 1]");

  let previousVolume = 0;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (!(run.hi > run.lo))
      throw new RangeError("pressure run interval must be positive");
    if (index > 0 && runs[index - 1]!.hi !== run.lo)
      throw new RangeError("pressure runs must be contiguous");
    if (
      run.volume < previousVolume &&
      !sameFrontierVolume(run.volume, previousVolume)
    )
      throw new RangeError("edge pressure must be non-decreasing in price");

    previousVolume = run.volume;
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

  if (run.volume > 0 && cursor < run.volume)
    throw new RangeError("pressure bands must contain current pressure");
}

function emptyRun(): MutableRun {
  return {
    lo: PRICE_ZERO,
    hi: PRICE_ONE,
    volume: 0,
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
