import {
  frontierVolumeThrough,
  sameFrontierVolume,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "../../src/domain/pressure/pressureField";
import {
  PRICE_ONE,
  PRICE_ZERO,
  type Price,
  priceFromTicks,
} from "../../src/domain/books/price";

/**
 * One explicit price boundary in the materialized pressure field.
 *
 * The state applies from `price` through the next stored price boundary.
 * There is deliberately no stored price-0 sentinel: disposing of an asset at
 * zero is a semantic boundary condition, not mutable book state.
 */
export interface PressureRenderRun {
  readonly price: Price;
  /** Current cumulative resting volume from this price onward. */
  readonly volume: number;
  /**
   * Historical pressure above the current volume frontier, stored high-to-low.
   * The final entry, when present, touches `volume`.
   */
  readonly frozenBands: readonly PressureBand[];
}

export interface PressureFieldRunSnapshot {
  readonly price: Price;
  readonly volume: number;
  readonly frozenBands: readonly PressureBand[];
}

export interface PressureFieldSnapshot {
  /** Semantic upper bound of this price domain. */
  readonly maxPrice: Price;
  readonly currentValidThroughMs: number | null;
  readonly runs: readonly PressureFieldRunSnapshot[];
}

export interface PressureLevelDelta {
  readonly price: Price;
  readonly delta: number;
}

interface MutableBand {
  loVolume: number;
  hiVolume: number;
  validThroughMs: number;
}

interface MutableRun {
  price: Price;
  volume: number;
  /** High-to-low; the last band is adjacent to the current volume frontier. */
  frozenBands: MutableBand[];
}

/**
 * Historical pressure for one directed token -> collateral edge.
 *
 * Only explicit non-zero price boundaries are stored. The implicit infinite
 * disposal order at price zero belongs to the asset semantics and never enters
 * this data structure.
 *
 * For each price run, current pressure is represented implicitly as
 * [0, volume). Only pressure that has left the current book is retained in
 * `frozenBands`. This makes a volume-frontier move a stack operation rather
 * than a rebuild of the full historical partition.
 */
export class MaterializedPressureField {
  private runs: MutableRun[] = [];
  private currentValidThroughMs: number | undefined;

  constructor(private readonly maxPrice: Price = PRICE_ONE) {
    if (!(maxPrice > PRICE_ZERO))
      throw new RangeError("pressure max price must be positive");
  }

  renderRuns(): readonly PressureRenderRun[] {
    return this.runs;
  }

  renderMaxPrice(): Price {
    return this.maxPrice;
  }

  renderCurrentValidThroughMs(): number | undefined {
    return this.currentValidThroughMs;
  }

  /** Explicit stored price boundaries only; the implicit price-zero sentinel is absent. */
  priceBoundaries(): readonly Price[] {
    return this.runs.map((run) => run.price);
  }

  bandsAtPrice(price: Price): readonly PressureBand[] {
    const run = this.runAtPrice(price);
    return run ? materializeBands(run, this.currentValidThroughMs) : [];
  }

  bandAtPoint(price: Price, volume: number): PressureBand | undefined {
    if (!Number.isFinite(volume) || volume < 0) return undefined;

    const run = this.runAtPrice(price);
    if (!run) return undefined;

    if (volume < run.volume) {
      const validThroughMs = this.currentValidThroughMs;
      return validThroughMs === undefined
        ? undefined
        : {
            loVolume: 0,
            hiVolume: run.volume,
            validThroughMs,
          };
    }

    const band = frozenBandAt(run.frozenBands, volume);
    return band ? cloneBand(band) : undefined;
  }

  applyDeltas(
    deltas: readonly PressureLevelDelta[],
    nextFrontier: FrontierRoot,
  ): void {
    const actual = validDeltas(deltas, this.maxPrice);
    if (actual.length === 0) return;

    actual.sort((a, b) => a.price - b.price);
    for (const { price } of actual) this.splitAt(price);

    const firstChangedPrice = actual[0]!.price;
    const firstRun = this.findInsertIndex(firstChangedPrice);

    for (let index = firstRun; index < this.runs.length; index++) {
      const run = this.runs[index]!;
      const nextVolume = frontierVolumeThrough(nextFrontier, run.price);
      if (sameFrontierVolume(nextVolume, run.volume)) continue;
      transitionRun(run, nextVolume, this.currentValidThroughMs);
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
    if (
      this.currentValidThroughMs !== undefined &&
      this.currentValidThroughMs > visibleSinceMs &&
      this.runs.some((run) => run.volume > 0)
    )
      return true;

    return this.runs.some((run) =>
      run.frozenBands.some((band) => band.validThroughMs > visibleSinceMs),
    );
  }

  clear(): void {
    this.runs = [];
    this.currentValidThroughMs = undefined;
  }

  snapshot(): PressureFieldSnapshot {
    return {
      maxPrice: this.maxPrice,
      currentValidThroughMs: this.currentValidThroughMs ?? null,
      runs: this.runs.map((run) => ({
        price: run.price,
        volume: run.volume,
        frozenBands: run.frozenBands.map(cloneBand),
      })),
    };
  }

  restore(snapshot: PressureFieldSnapshot): void {
    const maxPrice = priceFromTicks(snapshot.maxPrice);
    if (maxPrice !== this.maxPrice)
      throw new RangeError(
        `pressure max price mismatch: expected ${this.maxPrice}, got ${maxPrice}`,
      );

    const currentValidThroughMs =
      snapshot.currentValidThroughMs === null
        ? undefined
        : finite(snapshot.currentValidThroughMs, "current valid-through");

    if (!Array.isArray(snapshot.runs))
      throw new TypeError("pressure field runs must be an array");

    const runs: MutableRun[] = snapshot.runs.map((run) => ({
      price: priceFromTicks(run.price),
      volume: nonNegative(run.volume, "pressure volume"),
      frozenBands: run.frozenBands.map(cloneBand),
    }));

    validateRuns(runs, maxPrice, currentValidThroughMs);
    this.runs = runs;
    this.currentValidThroughMs = currentValidThroughMs;
    this.mergeAdjacentRuns();
  }

  validateAgainstFrontier(frontier: FrontierRoot): void {
    for (const run of this.runs) {
      const expected = frontierVolumeThrough(frontier, run.price);
      if (!sameFrontierVolume(run.volume, expected))
        throw new RangeError(
          "materialized pressure field does not match current frontier",
        );
    }
  }

  private runAtPrice(price: Price): MutableRun | undefined {
    if (price <= PRICE_ZERO || price > this.maxPrice || this.runs.length === 0)
      return undefined;

    const index = this.findInsertIndex(price);
    if (index < this.runs.length && this.runs[index]!.price === price)
      return this.runs[index];
    return index > 0 ? this.runs[index - 1] : undefined;
  }

  private splitAt(price: Price): void {
    if (!(price > PRICE_ZERO) || price > this.maxPrice) return;

    const index = this.findInsertIndex(price);
    if (index < this.runs.length && this.runs[index]!.price === price) return;

    const source = index > 0 ? this.runs[index - 1] : undefined;
    this.runs.splice(index, 0, {
      price,
      volume: source?.volume ?? 0,
      frozenBands: source?.frozenBands.map(cloneBand) ?? [],
    });
  }

  private findInsertIndex(price: Price): number {
    let lo = 0;
    let hi = this.runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.runs[mid]!.price < price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private mergeAdjacentRuns(): void {
    if (this.runs.length === 0) return;

    const merged: MutableRun[] = [];
    for (const run of this.runs) {
      const previous = merged[merged.length - 1];

      if (!previous && emptyState(run)) continue;
      if (previous && statesEqual(previous, run)) continue;

      merged.push(run);
    }
    this.runs = merged;
  }
}

function validDeltas(
  deltas: readonly PressureLevelDelta[],
  maxPrice: Price,
): PressureLevelDelta[] {
  return deltas.filter(
    ({ price, delta }) =>
      Number.isSafeInteger(price) &&
      price > PRICE_ZERO &&
      price <= maxPrice &&
      Number.isFinite(delta) &&
      delta !== 0,
  );
}

function transitionRun(
  run: MutableRun,
  nextVolume: number,
  currentValidThroughMs: number | undefined,
): void {
  nextVolume = nonNegative(nextVolume, "pressure volume");

  const oldVolume = run.volume;
  if (sameFrontierVolume(oldVolume, nextVolume)) {
    run.volume = nextVolume;
    return;
  }

  if (nextVolume < oldVolume) {
    if (currentValidThroughMs === undefined)
      throw new RangeError(
        "cannot freeze current pressure before it has a validity timestamp",
      );

    const last = run.frozenBands[run.frozenBands.length - 1];
    if (last && !sameFrontierVolume(last.loVolume, oldVolume))
      throw new RangeError(
        "frozen pressure stack is detached from the current frontier",
      );

    if (
      last &&
      last.validThroughMs === currentValidThroughMs &&
      sameFrontierVolume(last.loVolume, oldVolume)
    ) {
      last.loVolume = nextVolume;
    } else {
      run.frozenBands.push({
        loVolume: nextVolume,
        hiVolume: oldVolume,
        validThroughMs: currentValidThroughMs,
      });
    }
  } else {
    while (run.frozenBands.length > 0) {
      const last = run.frozenBands[run.frozenBands.length - 1]!;
      if (last.hiVolume <= nextVolume) {
        run.frozenBands.pop();
        continue;
      }

      if (last.loVolume < nextVolume) last.loVolume = nextVolume;
      break;
    }
  }

  run.volume = nextVolume;
}

function frozenBandAt(
  frozenBands: readonly MutableBand[],
  volume: number,
): MutableBand | undefined {
  // Bands are sorted high-to-low, so lower volumes live at larger indexes.
  let lo = 0;
  let hi = frozenBands.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const band = frozenBands[mid]!;
    if (volume < band.loVolume) lo = mid + 1;
    else if (volume >= band.hiVolume) hi = mid;
    else return band;
  }
  return undefined;
}

function materializeBands(
  run: MutableRun,
  currentValidThroughMs: number | undefined,
): PressureBand[] {
  const result: MutableBand[] = [];

  if (run.volume > 0) {
    if (currentValidThroughMs === undefined)
      throw new RangeError(
        "current pressure is missing its validity timestamp",
      );
    appendBand(result, {
      loVolume: 0,
      hiVolume: run.volume,
      validThroughMs: currentValidThroughMs,
    });
  }

  for (let index = run.frozenBands.length - 1; index >= 0; index--)
    appendBand(result, cloneBand(run.frozenBands[index]!));

  return result;
}

function appendBand(bands: MutableBand[], band: MutableBand): void {
  if (!Number.isFinite(band.validThroughMs)) return;

  const previous = bands[bands.length - 1];
  if (
    previous &&
    sameFrontierVolume(previous.hiVolume, band.loVolume) &&
    previous.validThroughMs === band.validThroughMs
  ) {
    previous.hiVolume = band.hiVolume;
    return;
  }
  bands.push(band);
}

function statesEqual(a: MutableRun, b: MutableRun): boolean {
  return (
    sameFrontierVolume(a.volume, b.volume) &&
    a.frozenBands.length === b.frozenBands.length &&
    a.frozenBands.every((band, index) =>
      bandsEqual(band, b.frozenBands[index]!),
    )
  );
}

function bandsEqual(a: MutableBand, b: MutableBand): boolean {
  return (
    sameFrontierVolume(a.loVolume, b.loVolume) &&
    sameFrontierVolume(a.hiVolume, b.hiVolume) &&
    a.validThroughMs === b.validThroughMs
  );
}

function emptyState(run: MutableRun): boolean {
  return sameFrontierVolume(run.volume, 0) && run.frozenBands.length === 0;
}

function validateRuns(
  runs: readonly MutableRun[],
  maxPrice: Price,
  currentValidThroughMs: number | undefined,
): void {
  let previousPrice = PRICE_ZERO;
  let previousVolume = 0;

  for (const run of runs) {
    if (!(run.price > previousPrice) || run.price > maxPrice)
      throw new RangeError(
        "pressure run prices must be strictly increasing non-zero boundaries",
      );

    if (
      run.volume < previousVolume &&
      !sameFrontierVolume(run.volume, previousVolume)
    )
      throw new RangeError("edge pressure must be non-decreasing in price");

    if (run.volume > 0 && currentValidThroughMs === undefined)
      throw new RangeError(
        "current pressure requires a current valid-through timestamp",
      );

    validateFrozenBands(run);
    previousPrice = run.price;
    previousVolume = run.volume;
  }

  if (runs[0] && emptyState(runs[0]))
    throw new RangeError("pressure field must not store a leading empty run");
}

function validateFrozenBands(run: MutableRun): void {
  let lowerEdge: number | undefined;

  for (const band of run.frozenBands) {
    if (
      !Number.isFinite(band.loVolume) ||
      !Number.isFinite(band.hiVolume) ||
      band.loVolume < 0 ||
      !(band.hiVolume > band.loVolume) ||
      !Number.isFinite(band.validThroughMs)
    )
      throw new RangeError("invalid frozen pressure band");

    if (
      lowerEdge !== undefined &&
      !sameFrontierVolume(lowerEdge, band.hiVolume)
    )
      throw new RangeError("frozen pressure bands must be contiguous");

    lowerEdge = band.loVolume;
  }

  if (lowerEdge !== undefined && !sameFrontierVolume(lowerEdge, run.volume))
    throw new RangeError(
      "frozen pressure bands must touch the current volume frontier",
    );
}

function cloneBand(band: PressureBand): MutableBand {
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
