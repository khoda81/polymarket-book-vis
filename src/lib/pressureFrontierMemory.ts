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
  restoreCurrent,
  snapshotCurrent,
  type PressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

export interface PressureLevelChange {
  readonly price: Price;
  readonly shares: number;
}

interface UpdatePlan {
  readonly observed: boolean;
  readonly next: FrontierRoot;
  readonly deltas: readonly PressureLevelDelta[];
}

/**
 * Timestamped pressure for one directed token -> collateral edge.
 *
 * This object has no market/opposing-token/bid/ask semantics. It stores one
 * token-local cumulative supply surface and can therefore be persisted and
 * rendered independently.
 */
export class PressureFrontierMemory {
  private current: FrontierRoot = null;
  private field = new MaterializedPressureField();
  private lastUpdateMs: number | undefined;

  observeLevels(
    levels: readonly FrontierLevel[],
    validThroughMs: number,
  ): void {
    validThroughMs = this.normalizeTime(validThroughMs);
    const plan = this.planReplacement(levels);
    this.applyPlan(plan, validThroughMs);
    this.field.observeCurrent(validThroughMs);
    this.lastUpdateMs = validThroughMs;
  }

  updateLevels(
    changes: readonly PressureLevelChange[],
    validThroughMs: number,
  ): void {
    validThroughMs = this.normalizeTime(validThroughMs);
    const plan = this.planLevelChanges(changes);
    if (!plan.observed) return;

    this.applyPlan(plan, validThroughMs);
    this.field.observeCurrent(validThroughMs);
    this.lastUpdateMs = validThroughMs;
  }

  snapshot(): PressureFrontierSnapshot {
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      current: snapshotCurrent(this.current),
      field: this.field.snapshot(),
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    const current = restoreCurrent(parsed.current);
    const field = new MaterializedPressureField();
    field.restore(parsed.field);
    field.validateAgainstFrontier(current);

    const boundaries = new Set(field.priceBoundaries());
    for (const { key } of frontierLevels(current))
      if (!boundaries.has(key))
        throw new RangeError(
          "materialized pressure field is missing a frontier boundary",
        );

    this.current = current;
    this.field = field;
    this.lastUpdateMs = newestValidThrough(parsed.field);
  }

  priceBoundaries(): readonly Price[] {
    return this.field.priceBoundaries();
  }

  renderRuns(): readonly PressureRenderRun[] {
    return this.field.renderRuns();
  }

  bandsAtPrice(price: Price): readonly PressureBand[] {
    return this.field.bandsAtPrice(price);
  }

  hasVisiblePressure(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    return this.field.hasVisiblePressure(
      visibleSinceMs(nowMs, halfLifeMs, minAlpha),
    );
  }

  clear(): void {
    this.current = null;
    this.field.clear();
    this.lastUpdateMs = undefined;
  }

  currentLevels(): readonly FrontierLevel[] {
    return frontierLevels(this.current);
  }

  private planLevelChanges(
    changes: readonly PressureLevelChange[],
  ): UpdatePlan {
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
      return { observed: false, next: this.current, deltas: [] };

    let next = this.current;
    const deltas: PressureLevelDelta[] = [];
    for (const [price, shares] of finalByPrice) {
      const previousShares = frontierLevel(next, price);
      if (shares === previousShares) continue;
      next = setFrontierLevel(next, price, shares);
      deltas.push({ price, delta: shares - previousShares });
    }

    return { observed: true, next, deltas };
  }

  private planReplacement(levels: readonly FrontierLevel[]): UpdatePlan {
    const normalized = normalizeLevels(levels);
    const previousLevels = frontierLevels(this.current);
    if (levelsEqual(previousLevels, normalized))
      return { observed: true, next: this.current, deltas: [] };

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

  private applyPlan(plan: UpdatePlan, validThroughMs: number): void {
    this.field.applyDeltas(plan.deltas, validThroughMs, plan.next);
    if (plan.deltas.length > 0) this.current = plan.next;
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
  field: PressureFrontierSnapshot["field"],
): number | undefined {
  let newest =
    field.currentValidThroughMs ?? Number.NEGATIVE_INFINITY;
  for (const run of field.runs)
    for (const band of run.bands)
      newest = Math.max(newest, band.validThroughMs);
  return Number.isFinite(newest) ? newest : undefined;
}
