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
    }
  | {
      kind: "resolvedUnbounded";
      resolvedAtMs: number | null;
    };

const EMPTY_RUNS: readonly PressureRun[] = [];
const EMPTY_CUMULATIVE_SHARES: readonly number[] = [];
const MAX_RENDER_CHANGE_HISTORY = 64;

interface RenderChange {
  readonly revision: number;
  readonly firstRunIndex: number;
}

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
  private cumulativeShares: number[] | null = null;
  private readonly renderChanges: RenderChange[] = [];

  /** Install a complete observation without bridging a continuity gap. */
  observeLevels(
    levels: readonly PressureLevel[],
    validThroughMs: number,
  ): boolean {
    this.ensureMutable();
    validThroughMs = this.requireMonotonicTime(validThroughMs);
    const previousValidThroughMs = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    const firstChangedRunIndex = this.applyReplacement(
      observed.runs,
      normalizeLevels(levels),
      previousValidThroughMs,
    );
    observed.validThroughMs = validThroughMs;
    if (firstChangedRunIndex !== null)
      this.recordRenderChange(firstChangedRunIndex);
    return (
      firstChangedRunIndex !== null || validThroughMs !== previousValidThroughMs
    );
  }

  /** Apply an ordered-stream delta; old liquidity survives through this time. */
  updateLevels(
    changes: readonly PressureLevelChange[],
    validThroughMs: number,
  ): boolean {
    this.ensureMutable();
    validThroughMs = this.requireMonotonicTime(validThroughMs);
    const normalized = normalizeChanges(changes);
    if (normalized.size === 0) return this.observeThrough(validThroughMs);

    const previousValidThroughMs = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    const firstChangedRunIndex = this.applyChanges(
      observed.runs,
      normalized,
      validThroughMs,
    );
    observed.validThroughMs = validThroughMs;
    if (firstChangedRunIndex !== null)
      this.recordRenderChange(firstChangedRunIndex);
    return (
      firstChangedRunIndex !== null || validThroughMs !== previousValidThroughMs
    );
  }

  /** Replace the full book on a known-continuous ordered stream. */
  replaceContinuous(
    levels: readonly PressureLevel[],
    validThroughMs: number,
  ): boolean {
    const advanced = this.observeThrough(validThroughMs);
    const replaced = this.observeLevels(levels, validThroughMs);
    return advanced || replaced;
  }

  /** Advance current pressure validity without changing geometry. */
  observeThrough(validThroughMs: number): boolean {
    if (this.state.kind === "resolvedUnbounded") return false;
    validThroughMs = this.requireMonotonicTime(validThroughMs);
    const previous = this.currentValidThroughMs();
    const observed = this.ensureObserved(validThroughMs);
    observed.validThroughMs = validThroughMs;
    return validThroughMs !== previous;
  }

  resolveUnbounded(resolvedAtMs: number | null): boolean {
    if (resolvedAtMs !== null) this.requireMonotonicTime(resolvedAtMs);

    if (this.state.kind === "resolvedUnbounded") {
      const previous = this.state.resolvedAtMs;
      const next =
        previous === null
          ? resolvedAtMs
          : resolvedAtMs === null
            ? previous
            : Math.max(previous, resolvedAtMs);
      if (next === previous) return false;
      this.state = { kind: "resolvedUnbounded", resolvedAtMs: next };
      return true;
    }

    this.state = { kind: "resolvedUnbounded", resolvedAtMs };
    this.cumulativeShares = null;
    this.recordRenderChange(0);
    return true;
  }

  resolveZeroFuture(resolvedAtMs: number | null): boolean {
    if (this.state.kind === "resolvedUnbounded") return false;
    if (resolvedAtMs !== null)
      return this.replaceContinuous([], this.requireMonotonicTime(resolvedAtMs));

    const current = this.currentValidThroughMs();
    return current === undefined ? false : this.replaceContinuous([], current);
  }

  isResolvedUnbounded(): boolean {
    return this.state.kind === "resolvedUnbounded";
  }

  validThroughMs(): number | undefined {
    return this.currentValidThroughMs();
  }

  snapshot(): PressureFrontierSnapshot {
    const state =
      this.state.kind === "unobserved"
        ? ({ kind: "unobserved" } as const)
        : this.state.kind === "resolvedUnbounded"
          ? ({
              kind: "resolvedUnbounded",
              resolvedAtMs: this.state.resolvedAtMs,
            } as const)
          : ({
              kind: "observed",
              validThroughMs: this.state.validThroughMs,
              runs: this.state.runs.map(cloneRun),
            } as const);

    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state,
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    this.state =
      parsed.state.kind === "unobserved"
        ? { kind: "unobserved" }
        : parsed.state.kind === "resolvedUnbounded"
          ? {
              kind: "resolvedUnbounded",
              resolvedAtMs: parsed.state.resolvedAtMs,
            }
          : {
              kind: "observed",
              validThroughMs: parsed.state.validThroughMs,
              runs: parsed.state.runs.map(cloneRun),
            };
    this.cumulativeShares = null;
    this.recordRenderChange(0);
  }

  priceBoundaries(): readonly Price[] {
    return this.state.kind === "observed"
      ? this.state.runs.map((run) => run.price)
      : [];
  }

  renderRuns(): readonly PressureRun[] {
    return this.state.kind === "observed" ? this.state.runs : EMPTY_RUNS;
  }

  /** Derived cumulative shares aligned one-to-one with renderRuns(). */
  renderCumulativeShares(): readonly number[] {
    return this.state.kind === "observed"
      ? this.ensureCumulativeShares(this.state.runs)
      : EMPTY_CUMULATIVE_SHARES;
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

  /**
   * Earliest run whose flattened render data may differ from a cached
   * revision. Falls back to zero when the renderer is older than our bounded
   * derived change history.
   */
  renderFirstChangedRunSince(revision: number): number {
    const runCount = this.renderRuns().length;
    if (revision === this.renderRevision) return runCount;
    if (revision < 0 || revision > this.renderRevision) return 0;

    const first = this.renderChanges.find(
      (change) => change.revision > revision,
    );
    if (!first || first.revision !== revision + 1) return 0;

    let firstRunIndex = first.firstRunIndex;
    for (const change of this.renderChanges)
      if (change.revision > first.revision)
        firstRunIndex = Math.min(firstRunIndex, change.firstRunIndex);
    return Math.min(firstRunIndex, runCount);
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

    const stepIndex = frozenStepIndexAt(run.frozenSteps, volume);
    if (stepIndex === undefined) return undefined;

    const step = run.frozenSteps[stepIndex]!;
    return {
      loVolume:
        stepIndex + 1 < run.frozenSteps.length
          ? run.frozenSteps[stepIndex + 1]!.hiVolume
          : currentVolume,
      hiVolume: step.hiVolume,
      validThroughMs: step.validThroughMs,
    };
  }

  hasVisiblePressure(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    if (this.state.kind !== "observed") return false;
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

  currentLevels(): readonly PressureLevel[] {
    if (this.state.kind !== "observed") return [];
    return this.state.runs.flatMap((run) =>
      run.shares > 0 ? [{ price: run.price, shares: run.shares }] : [],
    );
  }

  private ensureObserved(
    validThroughMs: number,
  ): Extract<MutablePressureState, { kind: "observed" }> {
    if (this.state.kind === "observed") return this.state;
    this.ensureMutable();
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
  ): number | null {
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
  ): number | null {
    const changes = new Map<Price, number>();
    for (const [price, shares] of requested)
      if (this.exactSharesAt(runs, price) !== shares)
        changes.set(price, shares);
    if (changes.size === 0) return null;

    const changedPrices = [...changes.keys()].sort((a, b) => a - b);
    const firstPrice = changedPrices[0]!;
    const firstOriginalIndex = findInsertIndex(runs, firstPrice);
    const cumulativeShares = this.ensureCumulativeShares(runs);
    const prefixVolume =
      firstOriginalIndex > 0 ? cumulativeShares[firstOriginalIndex - 1]! : 0;

    for (const price of changedPrices) this.splitAt(runs, price);

    const firstChangedRunIndex = findInsertIndex(runs, firstPrice);

    let oldVolume = prefixVolume;
    let nextVolume = prefixVolume;
    for (let index = firstChangedRunIndex; index < runs.length; index++) {
      const run = runs[index]!;
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

    const firstPossiblyMergedRun = Math.max(0, firstChangedRunIndex - 1);
    mergeAdjacentRunsFrom(runs, firstPossiblyMergedRun);
    this.rebuildCumulativeSharesFrom(runs, firstPossiblyMergedRun);
    return firstPossiblyMergedRun;
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
      this.state.kind !== "observed" ||
      price <= PRICE_ZERO ||
      price > PRICE_ONE
    )
      return undefined;

    const runs = this.state.runs;
    const insertion = findInsertIndex(runs, price);
    const index =
      insertion < runs.length && runs[insertion]!.price === price
        ? insertion
        : insertion - 1;
    if (index < 0) return undefined;

    return {
      run: runs[index]!,
      currentVolume: this.ensureCumulativeShares(runs)[index]!,
    };
  }

  private ensureCumulativeShares(runs: readonly MutableRun[]): number[] {
    if (this.cumulativeShares !== null) return this.cumulativeShares;

    const cumulativeShares = new Array<number>(runs.length);
    let cumulative = 0;
    for (let index = 0; index < runs.length; index++) {
      cumulative += runs[index]!.shares;
      cumulativeShares[index] = cumulative;
    }
    this.cumulativeShares = cumulativeShares;
    return cumulativeShares;
  }

  private rebuildCumulativeSharesFrom(
    runs: readonly MutableRun[],
    firstRunIndex: number,
  ): void {
    const cumulativeShares = this.cumulativeShares ?? [];
    cumulativeShares.length = runs.length;

    let cumulative =
      firstRunIndex > 0 ? cumulativeShares[firstRunIndex - 1]! : 0;
    for (let index = firstRunIndex; index < runs.length; index++) {
      cumulative += runs[index]!.shares;
      cumulativeShares[index] = cumulative;
    }
    this.cumulativeShares = cumulativeShares;
  }

  private recordRenderChange(firstRunIndex: number): void {
    this.renderRevision++;
    this.renderChanges.push({
      revision: this.renderRevision,
      firstRunIndex,
    });
    if (this.renderChanges.length > MAX_RENDER_CHANGE_HISTORY)
      this.renderChanges.shift();
  }

  private currentValidThroughMs(): number | undefined {
    if (this.state.kind === "observed") return this.state.validThroughMs;
    if (this.state.kind === "resolvedUnbounded")
      return this.state.resolvedAtMs ?? undefined;
    return undefined;
  }

  private ensureMutable(): void {
    if (this.state.kind === "resolvedUnbounded")
      throw new RangeError("resolved unbounded pressure is terminal");
  }

  private requireMonotonicTime(value: number): number {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(
        "pressure frontier timestamp must be finite and non-negative",
      );
    const previous = this.currentValidThroughMs();
    if (previous !== undefined && value < previous)
      throw new RangeError(
        "pressure frontier timestamp moved backward: " +
          value +
          " < " +
          previous,
      );
    return value;
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

function mergeAdjacentRunsFrom(
  runs: MutableRun[],
  firstRunIndex: number,
): void {
  let writeIndex = firstRunIndex;

  for (let readIndex = firstRunIndex; readIndex < runs.length; readIndex++) {
    const run = runs[readIndex]!;
    const previous = writeIndex > 0 ? runs[writeIndex - 1] : undefined;

    if (!previous && run.shares === 0 && run.frozenSteps.length === 0) continue;
    if (
      previous &&
      run.shares === 0 &&
      frozenStepsEqual(previous.frozenSteps, run.frozenSteps)
    )
      continue;

    runs[writeIndex] = run;
    writeIndex++;
  }

  runs.length = writeIndex;
}

function frozenStepIndexAt(
  steps: readonly FrozenStep[],
  volume: number,
): number | undefined {
  // Upper edges are strictly decreasing. Find the last (lowest) edge that is
  // still above the point volume.
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (steps[mid]!.hiVolume > volume) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lo - 1 : undefined;
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
