import { visibleSinceMs, type PressureBand } from "./pressureField";
import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";
import {
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  parsePressureFrontierSnapshot,
  type FrozenStep,
  type PressureFrontierSnapshot,
  type PressureRun,
} from "./pressureFrontierSnapshot";

export interface PressureLevel {
  readonly price: Price;
  readonly shares: number;
}

export type PressureLevelChange = PressureLevel;

interface MutableRun {
  price: Price;
  shares: number;
  frozenSteps: FrozenStep[];
}

type MutablePressureState =
  | {
      kind: "unobserved";
    }
  | {
      kind: "observed";
      validThroughMs: number;
      runs: MutableRun[];
    };

const EMPTY_RUNS: readonly PressureRun[] = [];

/**
 * Canonical token-local pressure state.
 *
 * Exact resting shares live directly on price runs. Cumulative pressure is a
 * derived prefix sum while traversing those runs. Frozen history stores only
 * upper cumulative edges; lower edges are implicit in the next step/current
 * cumulative frontier.
 */
export class PressureFrontierMemory {
  private state: MutablePressureState = { kind: "unobserved" };
  private renderRevision = 0;

  observeLevels(
    levels: readonly PressureLevel[],
    validThroughMs: number,
  ): boolean {
    validThroughMs = this.normalizeTime(validThroughMs);
    const previousValidThroughMs = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    const geometryChanged = this.applyReplacement(
      observed.runs,
      normalizeLevels(levels),
      previousValidThroughMs,
    );
    observed.validThroughMs = validThroughMs;
    if (geometryChanged) this.renderRevision++;
    return geometryChanged || validThroughMs !== previousValidThroughMs;
  }

  updateLevels(
    changes: readonly PressureLevelChange[],
    validThroughMs: number,
  ): boolean {
    const normalized = normalizeChanges(changes);
    if (normalized.size === 0) return false;

    validThroughMs = this.normalizeTime(validThroughMs);
    const previousValidThroughMs = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    const geometryChanged = this.applyChanges(
      observed.runs,
      normalized,
      previousValidThroughMs,
    );
    observed.validThroughMs = validThroughMs;
    if (geometryChanged) this.renderRevision++;
    return geometryChanged || validThroughMs !== previousValidThroughMs;
  }

  /** Advance the current pressure validity without changing its geometry. */
  observeThrough(validThroughMs: number): boolean {
    validThroughMs = this.normalizeTime(validThroughMs);
    const previous = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    observed.validThroughMs = validThroughMs;
    return validThroughMs !== previous;
  }

  snapshot(): PressureFrontierSnapshot {
    if (this.state.kind === "unobserved")
      return {
        version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
        state: { kind: "unobserved" },
      };

    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: this.state.validThroughMs,
        runs: this.state.runs.map(cloneRun),
      },
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    this.state =
      parsed.state.kind === "unobserved"
        ? { kind: "unobserved" }
        : {
            kind: "observed",
            validThroughMs: parsed.state.validThroughMs,
            runs: parsed.state.runs.map(cloneRun),
          };
    this.renderRevision++;
  }

  priceBoundaries(): readonly Price[] {
    return this.state.kind === "observed"
      ? this.state.runs.map((run) => run.price)
      : [];
  }

  renderRuns(): readonly PressureRun[] {
    return this.state.kind === "observed" ? this.state.runs : EMPTY_RUNS;
  }

  renderCurrentValidThroughMs(): number | undefined {
    return this.currentValidThroughMs();
  }

  renderMaxPrice(): Price {
    return PRICE_ONE;
  }

  renderDataRevision(): number {
    return this.renderRevision;
  }

  bandsAtPrice(price: Price): readonly PressureBand[] {
    const context = this.runContextAtPrice(price);
    if (!context || this.state.kind !== "observed") return [];
    return materializeBands(
      context.run,
      context.currentVolume,
      this.state.validThroughMs,
    );
  }

  bandAtPoint(price: Price, volume: number): PressureBand | undefined {
    if (!Number.isFinite(volume) || volume < 0) return undefined;

    const context = this.runContextAtPrice(price);
    if (!context || this.state.kind !== "observed") return undefined;

    const { run, currentVolume } = context;
    if (volume < currentVolume)
      return {
        loVolume: 0,
        hiVolume: currentVolume,
        validThroughMs: this.state.validThroughMs,
      };

    let lower = currentVolume;
    for (let index = run.frozenSteps.length - 1; index >= 0; index--) {
      const step = run.frozenSteps[index]!;
      if (volume >= lower && volume < step.hiVolume)
        return {
          loVolume: lower,
          hiVolume: step.hiVolume,
          validThroughMs: step.validThroughMs,
        };
      lower = step.hiVolume;
    }

    return undefined;
  }

  hasVisiblePressure(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    if (this.state.kind === "unobserved") return false;
    const visibleSince = visibleSinceMs(nowMs, halfLifeMs, minAlpha);

    if (
      this.state.validThroughMs > visibleSince &&
      this.state.runs.some((run) => run.shares > 0)
    )
      return true;

    return this.state.runs.some((run) =>
      run.frozenSteps.some((step) => step.validThroughMs > visibleSince),
    );
  }

  clear(): void {
    if (this.state.kind === "unobserved") return;
    this.state = { kind: "unobserved" };
    this.renderRevision++;
  }

  currentLevels(): readonly PressureLevel[] {
    if (this.state.kind === "unobserved") return [];
    return this.state.runs.flatMap((run) =>
      run.shares > 0 ? [{ price: run.price, shares: run.shares }] : [],
    );
  }

  private ensureObserved(
    validThroughMs: number,
  ): Extract<MutablePressureState, { kind: "observed" }> {
    if (this.state.kind === "observed") return this.state;
    const observed: Extract<MutablePressureState, { kind: "observed" }> = {
      kind: "observed",
      validThroughMs,
      runs: [],
    };
    this.state = observed;
    return observed;
  }

  private applyReplacement(
    runs: MutableRun[],
    desired: ReadonlyMap<Price, number>,
    previousValidThroughMs: number | undefined,
  ): boolean {
    const changes = new Map<Price, number>();
    for (const run of runs)
      if (run.shares > 0 && !desired.has(run.price)) changes.set(run.price, 0);
    for (const [price, shares] of desired)
      if (this.exactSharesAt(runs, price) !== shares)
        changes.set(price, shares);

    return this.applyChanges(runs, changes, previousValidThroughMs);
  }

  private applyChanges(
    runs: MutableRun[],
    requested: ReadonlyMap<Price, number>,
    previousValidThroughMs: number | undefined,
  ): boolean {
    const changes = new Map<Price, number>();
    for (const [price, shares] of requested)
      if (this.exactSharesAt(runs, price) !== shares)
        changes.set(price, shares);
    if (changes.size === 0) return false;

    for (const price of [...changes.keys()].sort((a, b) => a - b))
      this.splitAt(runs, price);

    let oldVolume = 0;
    let nextVolume = 0;
    for (const run of runs) {
      const oldShares = run.shares;
      const nextShares = changes.get(run.price) ?? oldShares;
      oldVolume += oldShares;
      nextVolume += nextShares;

      if (!samePressureVolume(oldVolume, nextVolume))
        transitionFrozenSteps(
          run.frozenSteps,
          oldVolume,
          nextVolume,
          previousValidThroughMs,
        );

      run.shares = nextShares;
    }

    const merged = mergeAdjacentRuns(runs);
    runs.splice(0, runs.length, ...merged);
    return true;
  }

  private exactSharesAt(runs: readonly MutableRun[], price: Price): number {
    const index = findInsertIndex(runs, price);
    return index < runs.length && runs[index]!.price === price
      ? runs[index]!.shares
      : 0;
  }

  private splitAt(runs: MutableRun[], price: Price): void {
    const index = findInsertIndex(runs, price);
    if (index < runs.length && runs[index]!.price === price) return;

    const source = index > 0 ? runs[index - 1] : undefined;
    runs.splice(index, 0, {
      price,
      shares: 0,
      frozenSteps: source?.frozenSteps.map(cloneStep) ?? [],
    });
  }

  private runContextAtPrice(
    price: Price,
  ): { run: MutableRun; currentVolume: number } | undefined {
    if (
      this.state.kind === "unobserved" ||
      price <= PRICE_ZERO ||
      price > PRICE_ONE
    )
      return undefined;

    let currentVolume = 0;
    let selected: MutableRun | undefined;
    let selectedVolume = 0;

    for (const run of this.state.runs) {
      if (run.price > price) break;
      currentVolume += run.shares;
      selected = run;
      selectedVolume = currentVolume;
    }

    return selected
      ? { run: selected, currentVolume: selectedVolume }
      : undefined;
  }

  private currentValidThroughMs(): number | undefined {
    return this.state.kind === "observed"
      ? this.state.validThroughMs
      : undefined;
  }

  private normalizeTime(value: number): number {
    if (!Number.isFinite(value))
      throw new RangeError("pressure frontier timestamp must be finite");
    const previous = this.currentValidThroughMs();
    return previous === undefined ? value : Math.max(value, previous);
  }
}

function normalizeLevels(
  levels: readonly PressureLevel[],
): ReadonlyMap<Price, number> {
  const byPrice = new Map<Price, number>();
  for (const level of levels) {
    const price = canonicalPrice(level.price);
    if (
      price === undefined ||
      !Number.isFinite(level.shares) ||
      !(level.shares > 0)
    )
      continue;
    byPrice.set(price, (byPrice.get(price) ?? 0) + level.shares);
  }
  return byPrice;
}

function normalizeChanges(
  changes: readonly PressureLevelChange[],
): ReadonlyMap<Price, number> {
  const byPrice = new Map<Price, number>();
  for (const change of changes) {
    const price = canonicalPrice(change.price);
    if (
      price === undefined ||
      !Number.isFinite(change.shares) ||
      change.shares < 0
    )
      continue;
    byPrice.set(price, change.shares);
  }
  return byPrice;
}

function canonicalPrice(value: Price): Price | undefined {
  try {
    const price = priceFromTicks(value);
    return price > PRICE_ZERO && price <= PRICE_ONE ? price : undefined;
  } catch {
    return undefined;
  }
}

function transitionFrozenSteps(
  steps: FrozenStep[],
  oldVolume: number,
  nextVolume: number,
  previousValidThroughMs: number | undefined,
): void {
  if (nextVolume < oldVolume) {
    if (previousValidThroughMs === undefined)
      throw new RangeError(
        "cannot freeze current pressure before it has a validity timestamp",
      );

    const last = steps[steps.length - 1];
    if (!last || last.validThroughMs !== previousValidThroughMs)
      steps.push({
        hiVolume: oldVolume,
        validThroughMs: previousValidThroughMs,
      });
    return;
  }

  while (steps.length > 0) {
    const last = steps[steps.length - 1]!;
    if (
      last.hiVolume < nextVolume ||
      samePressureVolume(last.hiVolume, nextVolume)
    ) {
      steps.pop();
      continue;
    }
    break;
  }
}

function mergeAdjacentRuns(runs: readonly MutableRun[]): MutableRun[] {
  const merged: MutableRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];

    if (!previous && run.shares === 0 && run.frozenSteps.length === 0) continue;
    if (
      previous &&
      run.shares === 0 &&
      frozenStepsEqual(previous.frozenSteps, run.frozenSteps)
    )
      continue;

    merged.push(run);
  }
  return merged;
}

function materializeBands(
  run: MutableRun,
  currentVolume: number,
  currentValidThroughMs: number,
): PressureBand[] {
  const result: Array<{
    loVolume: number;
    hiVolume: number;
    validThroughMs: number;
  }> = [];

  if (currentVolume > 0)
    appendBand(result, {
      loVolume: 0,
      hiVolume: currentVolume,
      validThroughMs: currentValidThroughMs,
    });

  let lower = currentVolume;
  for (let index = run.frozenSteps.length - 1; index >= 0; index--) {
    const step = run.frozenSteps[index]!;
    appendBand(result, {
      loVolume: lower,
      hiVolume: step.hiVolume,
      validThroughMs: step.validThroughMs,
    });
    lower = step.hiVolume;
  }

  return result;
}

function appendBand(
  bands: Array<{
    loVolume: number;
    hiVolume: number;
    validThroughMs: number;
  }>,
  band: { loVolume: number; hiVolume: number; validThroughMs: number },
): void {
  const previous = bands[bands.length - 1];
  if (
    previous &&
    samePressureVolume(previous.hiVolume, band.loVolume) &&
    previous.validThroughMs === band.validThroughMs
  ) {
    previous.hiVolume = band.hiVolume;
    return;
  }
  bands.push(band);
}

function findInsertIndex(runs: readonly MutableRun[], price: Price): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs[mid]!.price < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function frozenStepsEqual(
  a: readonly FrozenStep[],
  b: readonly FrozenStep[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (step, index) =>
        samePressureVolume(step.hiVolume, b[index]!.hiVolume) &&
        step.validThroughMs === b[index]!.validThroughMs,
    )
  );
}

function cloneStep(step: FrozenStep): FrozenStep {
  return {
    hiVolume: step.hiVolume,
    validThroughMs: step.validThroughMs,
  };
}

function cloneRun(run: PressureRun): MutableRun {
  return {
    price: run.price,
    shares: run.shares,
    frozenSteps: run.frozenSteps.map(cloneStep),
  };
}

/** Allow only floating-point summation-order noise when comparing boundaries. */
function samePressureVolume(a: number, b: number): boolean {
  return Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, a, b);
}
