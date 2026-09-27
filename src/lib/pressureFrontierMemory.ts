import {
  MaterializedPressureField,
  type PressureLevelDelta,
  type PressureRenderRun,
} from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevel,
  frontierLevels,
  setFrontierLevel,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import { visibleSinceMs, type PressureBand } from "./pressureField";
import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";
import {
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  parsePressureFrontierSnapshot,
  restoreEdgeCurrent,
  snapshotEdge,
  type PressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

export type PressureEdge = "primaryToCollateral" | "oppositeToCollateral";

export interface PressureLevelChange {
  readonly price: Price;
  readonly shares: number;
}

interface EdgeState {
  current: FrontierRoot;
  field: MaterializedPressureField;
}

interface EdgeUpdatePlan {
  readonly observed: boolean;
  readonly next: FrontierRoot;
  readonly deltas: readonly PressureLevelDelta[];
}

/**
 * Timestamped pressure for the two outcome-token -> collateral edges of one
 * binary market.
 *
 * Both edges have identical semantics and edge-local price coordinates. This
 * class intentionally knows nothing about CLOB bid/ask sides or screen
 * orientation; adapters and render perspectives live outside it.
 */
export class PressureFrontierMemory {
  private readonly primaryToCollateral: EdgeState = {
    current: null,
    field: new MaterializedPressureField(),
  };
  private readonly oppositeToCollateral: EdgeState = {
    current: null,
    field: new MaterializedPressureField(),
  };
  private lastUpdateMs: number | undefined;

  observeEdges(
    primaryLevels: readonly FrontierLevel[],
    oppositeLevels: readonly FrontierLevel[],
    validThroughMs: number,
  ): void {
    validThroughMs = this.normalizeTime(validThroughMs);

    const primary = this.planReplacement(
      this.primaryToCollateral,
      primaryLevels,
    );
    const opposite = this.planReplacement(
      this.oppositeToCollateral,
      oppositeLevels,
    );

    this.applyPlan(this.primaryToCollateral, primary, validThroughMs);
    this.applyPlan(this.oppositeToCollateral, opposite, validThroughMs);
    this.observeCurrent(validThroughMs);
  }

  updateEdges(
    primaryChanges: readonly PressureLevelChange[],
    oppositeChanges: readonly PressureLevelChange[],
    validThroughMs: number,
  ): void {
    validThroughMs = this.normalizeTime(validThroughMs);
    const primary = this.planLevelChanges(
      this.primaryToCollateral,
      primaryChanges,
    );
    const opposite = this.planLevelChanges(
      this.oppositeToCollateral,
      oppositeChanges,
    );
    if (!primary.observed && !opposite.observed) return;

    this.applyPlan(this.primaryToCollateral, primary, validThroughMs);
    this.applyPlan(this.oppositeToCollateral, opposite, validThroughMs);
    this.observeCurrent(validThroughMs);
  }

  snapshot(): PressureFrontierSnapshot {
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      primaryToCollateral: snapshotEdge(
        this.primaryToCollateral.current,
        this.primaryToCollateral.field.snapshot(),
      ),
      oppositeToCollateral: snapshotEdge(
        this.oppositeToCollateral.current,
        this.oppositeToCollateral.field.snapshot(),
      ),
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    const restored = new PressureFrontierMemory();

    restored.restoreEdge(
      restored.primaryToCollateral,
      parsed.primaryToCollateral,
    );
    restored.restoreEdge(
      restored.oppositeToCollateral,
      parsed.oppositeToCollateral,
    );
    restored.lastUpdateMs = newestValidThrough([
      parsed.primaryToCollateral.field,
      parsed.oppositeToCollateral.field,
    ]);

    this.primaryToCollateral.current = restored.primaryToCollateral.current;
    this.primaryToCollateral.field = restored.primaryToCollateral.field;
    this.oppositeToCollateral.current = restored.oppositeToCollateral.current;
    this.oppositeToCollateral.field = restored.oppositeToCollateral.field;
    this.lastUpdateMs = restored.lastUpdateMs;
  }

  priceBoundaries(edge: PressureEdge): readonly Price[] {
    return this.edgeState(edge).field.priceBoundaries();
  }

  renderRuns(edge: PressureEdge): readonly PressureRenderRun[] {
    return this.edgeState(edge).field.renderRuns();
  }

  bandsAtPrice(edge: PressureEdge, price: Price): readonly PressureBand[] {
    return this.edgeState(edge).field.bandsAtPrice(price);
  }

  hasVisiblePressure(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    const since = visibleSinceMs(nowMs, halfLifeMs, minAlpha);
    return (
      this.primaryToCollateral.field.hasVisiblePressure(since) ||
      this.oppositeToCollateral.field.hasVisiblePressure(since)
    );
  }

  clear(): void {
    for (const edge of [this.primaryToCollateral, this.oppositeToCollateral]) {
      edge.current = null;
      edge.field.clear();
    }
    this.lastUpdateMs = undefined;
  }

  currentLevels(edge: PressureEdge): readonly FrontierLevel[] {
    return frontierLevels(this.edgeState(edge).current);
  }

  private planLevelChanges(
    state: EdgeState,
    changes: readonly PressureLevelChange[],
  ): EdgeUpdatePlan {
    const finalByPrice = new Map<Price, number>();

    for (const change of changes) {
      let price: Price;
      try {
        price = priceFromTicks(change.price);
      } catch {
        continue;
      }
      if (!Number.isFinite(change.shares) || change.shares < 0) continue;
      finalByPrice.set(price, change.shares);
    }
    if (finalByPrice.size === 0)
      return { observed: false, next: state.current, deltas: [] };

    let next = state.current;
    const deltas: PressureLevelDelta[] = [];
    for (const [price, shares] of finalByPrice) {
      const previousShares = frontierLevel(next, price);
      if (shares === previousShares) continue;
      next = setFrontierLevel(next, price, shares);
      deltas.push({ price, delta: shares - previousShares });
    }

    return { observed: true, next, deltas };
  }

  private planReplacement(
    state: EdgeState,
    levels: readonly FrontierLevel[],
  ): EdgeUpdatePlan {
    const normalized = normalizeLevels(levels);
    const previousLevels = frontierLevels(state.current);
    if (levelsEqual(previousLevels, normalized))
      return { observed: true, next: state.current, deltas: [] };

    const previousByPrice = new Map(
      previousLevels.map((level) => [level.key, level.weight] as const),
    );
    const nextByPrice = new Map(
      normalized.map((level) => [level.key, level.weight] as const),
    );
    const prices = new Set([...previousByPrice.keys(), ...nextByPrice.keys()]);
    const deltas: PressureLevelDelta[] = [];

    for (const price of prices) {
      const delta =
        (nextByPrice.get(price) ?? 0) - (previousByPrice.get(price) ?? 0);
      if (delta !== 0) deltas.push({ price, delta });
    }

    return { observed: true, next: buildFrontier(normalized), deltas };
  }

  private applyPlan(
    state: EdgeState,
    plan: EdgeUpdatePlan,
    validThroughMs: number,
  ): void {
    state.field.applyDeltas(plan.deltas, validThroughMs, plan.next);
    if (plan.deltas.length > 0) state.current = plan.next;
  }

  private observeCurrent(validThroughMs: number): void {
    this.primaryToCollateral.field.observeCurrent(validThroughMs);
    this.oppositeToCollateral.field.observeCurrent(validThroughMs);
    this.lastUpdateMs = validThroughMs;
  }

  private restoreEdge(
    state: EdgeState,
    snapshot: PressureFrontierSnapshot[PressureEdge],
  ): void {
    state.current = restoreEdgeCurrent(snapshot);
    state.field.restore(snapshot.field);
    state.field.validateAgainstFrontier(state.current);

    const boundaries = new Set(state.field.priceBoundaries());
    for (const { key } of frontierLevels(state.current))
      if (!boundaries.has(key))
        throw new RangeError(
          "materialized pressure field is missing a frontier boundary",
        );
  }

  private edgeState(edge: PressureEdge): EdgeState {
    return edge === "primaryToCollateral"
      ? this.primaryToCollateral
      : this.oppositeToCollateral;
  }

  private normalizeTime(value: number): number {
    if (!Number.isFinite(value))
      throw new RangeError("pressure frontier timestamp must be finite");

    return this.lastUpdateMs === undefined
      ? value
      : Math.max(value, this.lastUpdateMs);
  }
}

function normalizeLevels(levels: readonly FrontierLevel[]): FrontierLevel[] {
  const byPrice = new Map<Price, number>();
  for (const { key, weight } of levels) {
    if (
      !Number.isSafeInteger(key) ||
      key < PRICE_ZERO ||
      key > PRICE_ONE ||
      !Number.isFinite(weight) ||
      !(weight > 0)
    )
      continue;
    byPrice.set(key, (byPrice.get(key) ?? 0) + weight);
  }
  return [...byPrice]
    .sort(([a], [b]) => a - b)
    .map(([key, weight]) => ({ key, weight }));
}

function levelsEqual(
  a: readonly FrontierLevel[],
  b: readonly FrontierLevel[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (level, index) =>
        level.key === b[index]!.key && level.weight === b[index]!.weight,
    )
  );
}

function newestValidThrough(
  fields: readonly {
    readonly currentValidThroughMs: number | null;
    readonly runs: readonly { readonly bands: readonly PressureBand[] }[];
  }[],
): number | undefined {
  let newest = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    if (field.currentValidThroughMs !== null)
      newest = Math.max(newest, field.currentValidThroughMs);
    for (const run of field.runs)
      for (const band of run.bands)
        newest = Math.max(newest, band.validThroughMs);
  }
  return Number.isFinite(newest) ? newest : undefined;
}
