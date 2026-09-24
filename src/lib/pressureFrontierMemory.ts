import type { TokenBook } from "./orderBook";
import {
  MaterializedPressureField,
  type PressureBookSide,
  type PressureFieldRunSnapshot,
  type PressureRenderRun,
  type PressureSideDelta,
} from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevel,
  frontierLevels,
  frontierVolumeOnInterval,
  sameFrontierVolume,
  setFrontierLevel,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import { visibleSinceMs, type PressureBand } from "./pressureField";
import {
  PRICE_ONE,
  PRICE_ZERO,
  complementPrice,
  type Price,
  priceFromTicks,
} from "./price";
import {
  parsePressureFrontierSnapshot,
  restoreCurrentSide,
  snapshotCurrentSide,
  type PressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

export type { PressureBookSide, PressureRenderRun };

export interface PressureLevelChange {
  readonly price: Price;
  readonly shares: number;
}

interface SideFrontierState {
  current: FrontierRoot;
}

/**
 * Current liquidity lives in two monotone frontiers used for incremental
 * updates. The materialized field is the complete rendered observation history:
 * current pressure is simply the newest timestamped observation.
 */
export class PressureFrontierMemory {
  private readonly bid: SideFrontierState = { current: null };
  private readonly ask: SideFrontierState = { current: null };
  private field = new MaterializedPressureField();
  private lastUpdateMs: number | undefined;

  observeBook(book: TokenBook, validThroughMs: number): void {
    validThroughMs = this.normalizeTime(validThroughMs);

    this.replaceSide(
      "bid",
      [...book.usdToYes.asOrders()]
        .filter(validBookOrder)
        .map((order) => ({ key: order.price, weight: order.take })),
      validThroughMs,
    );
    this.replaceSide(
      "ask",
      [...book.yesToUsd.asSellOrders()].filter(validBookOrder).map((order) => ({
        key: complementPrice(order.price),
        weight: order.take,
      })),
      validThroughMs,
    );

    this.field.observeCurrent(validThroughMs);
    this.lastUpdateMs = validThroughMs;
  }

  updateLevels(
    side: PressureBookSide,
    changes: readonly PressureLevelChange[],
    validThroughMs: number,
  ): void {
    this.updateBookLevels(
      side === "bid" ? changes : [],
      side === "ask" ? changes : [],
      validThroughMs,
    );
  }

  updateBookLevels(
    bidChanges: readonly PressureLevelChange[],
    askChanges: readonly PressureLevelChange[],
    validThroughMs: number,
  ): void {
    validThroughMs = this.normalizeTime(validThroughMs);
    const bidObserved = this.applyLevels("bid", bidChanges, validThroughMs);
    const askObserved = this.applyLevels("ask", askChanges, validThroughMs);
    if (!bidObserved && !askObserved) return;

    this.field.observeCurrent(validThroughMs);
    this.lastUpdateMs = validThroughMs;
  }

  snapshot(): PressureFrontierSnapshot {
    return {
      bid: snapshotCurrentSide(this.bid.current),
      ask: snapshotCurrentSide(this.ask.current),
      field: this.field.snapshot(),
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    const restored = new PressureFrontierMemory();

    restored.bid.current = restoreCurrentSide(parsed.bid);
    restored.ask.current = restoreCurrentSide(parsed.ask);
    restored.field.restore(parsed.field);
    restored.validateFieldAgainstFrontiers(parsed.field.runs);
    restored.lastUpdateMs = newestValidThrough(parsed.field.runs);

    // Commit only a fully validated snapshot.
    this.bid.current = restored.bid.current;
    this.ask.current = restored.ask.current;
    this.field = restored.field;
    this.lastUpdateMs = restored.lastUpdateMs;
  }

  priceBoundaries(): readonly Price[] {
    return this.field.priceBoundaries();
  }

  renderRuns(): readonly PressureRenderRun[] {
    return this.field.renderRuns();
  }

  shellsAtPrice(price: Price): readonly PressureBand[] {
    return this.field.shellsAtPrice(price);
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
    this.bid.current = null;
    this.ask.current = null;
    this.field.clear();
    this.lastUpdateMs = undefined;
  }

  currentLevels(side: PressureBookSide): readonly FrontierLevel[] {
    return frontierLevels(this.sideState(side).current);
  }

  private applyLevels(
    side: PressureBookSide,
    changes: readonly PressureLevelChange[],
    validThroughMs: number,
  ): boolean {
    const state = this.sideState(side);
    const finalByKey = new Map<Price, number>();

    for (const change of changes) {
      const key = localKey(side, change.price);
      if (key === null) continue;
      if (!Number.isFinite(change.shares) || change.shares < 0) continue;
      finalByKey.set(key, change.shares);
    }
    if (finalByKey.size === 0) return false;

    let next = state.current;
    const deltas: PressureSideDelta[] = [];
    for (const [key, shares] of finalByKey) {
      const previousShares = frontierLevel(next, key);
      if (shares === previousShares) continue;
      next = setFrontierLevel(next, key, shares);
      deltas.push({
        price: side === "bid" ? key : complementPrice(key),
        delta: shares - previousShares,
      });
    }

    if (deltas.length > 0) {
      this.field.applySideDeltas(side, deltas, validThroughMs, next);
      state.current = next;
    }
    return true;
  }

  private replaceSide(
    side: PressureBookSide,
    levels: readonly FrontierLevel[],
    validThroughMs: number,
  ): void {
    const state = this.sideState(side);
    const normalized = normalizeLevels(levels);
    const previousLevels = frontierLevels(state.current);
    if (levelsEqual(previousLevels, normalized)) return;

    const previousByKey = new Map(
      previousLevels.map((level) => [level.key, level.weight] as const),
    );
    const nextByKey = new Map(
      normalized.map((level) => [level.key, level.weight] as const),
    );
    const keys = new Set([...previousByKey.keys(), ...nextByKey.keys()]);
    const deltas: PressureSideDelta[] = [];

    for (const key of keys) {
      const delta = (nextByKey.get(key) ?? 0) - (previousByKey.get(key) ?? 0);
      if (delta === 0) continue;
      deltas.push({
        price: side === "bid" ? key : complementPrice(key),
        delta,
      });
    }

    const next = buildFrontier(normalized);
    this.field.applySideDeltas(side, deltas, validThroughMs, next);
    state.current = next;
  }

  private validateFieldAgainstFrontiers(
    runs: readonly PressureFieldRunSnapshot[],
  ): void {
    const boundaries = new Set<Price>();
    for (const run of runs) {
      boundaries.add(run.lo);
      boundaries.add(run.hi);
    }
    for (const { key } of frontierLevels(this.bid.current))
      if (!boundaries.has(key))
        throw new RangeError(
          "materialized pressure field is missing a bid frontier boundary",
        );
    for (const { key } of frontierLevels(this.ask.current))
      if (!boundaries.has(complementPrice(key)))
        throw new RangeError(
          "materialized pressure field is missing an ask frontier boundary",
        );

    for (const run of runs) {
      const bidVolume = frontierVolumeOnInterval(
        this.bid.current,
        "bid",
        run.lo,
        run.hi,
      );
      const askVolume = frontierVolumeOnInterval(
        this.ask.current,
        "ask",
        run.lo,
        run.hi,
      );
      if (
        !sameFrontierVolume(run.bidVolume, bidVolume) ||
        !sameFrontierVolume(run.askVolume, askVolume)
      )
        throw new RangeError(
          "materialized pressure field does not match current frontiers",
        );
    }
  }

  private sideState(side: PressureBookSide): SideFrontierState {
    return side === "bid" ? this.bid : this.ask;
  }

  private normalizeTime(value: number): number {
    if (!Number.isFinite(value))
      throw new RangeError("pressure frontier timestamp must be finite");

    return this.lastUpdateMs === undefined
      ? value
      : Math.max(value, this.lastUpdateMs);
  }
}

function validBookOrder(order: {
  readonly price: Price;
  readonly take: number;
}): boolean {
  return (
    Number.isSafeInteger(order.price) &&
    order.price >= PRICE_ZERO &&
    order.price <= PRICE_ONE &&
    Number.isFinite(order.take) &&
    order.take > 0
  );
}

function localKey(side: PressureBookSide, canonicalPrice: Price): Price | null {
  try {
    priceFromTicks(canonicalPrice);
  } catch {
    return null;
  }
  return side === "bid" ? canonicalPrice : complementPrice(canonicalPrice);
}

function normalizeLevels(levels: readonly FrontierLevel[]): FrontierLevel[] {
  const byKey = new Map<Price, number>();
  for (const { key, weight } of levels) {
    if (
      !Number.isSafeInteger(key) ||
      key < PRICE_ZERO ||
      key > PRICE_ONE ||
      !Number.isFinite(weight) ||
      !(weight > 0)
    )
      continue;
    byKey.set(key, (byKey.get(key) ?? 0) + weight);
  }
  return [...byKey]
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
  runs: readonly { readonly bands: readonly PressureBand[] }[],
): number | undefined {
  let newest = Number.NEGATIVE_INFINITY;
  for (const run of runs)
    for (const band of run.bands)
      newest = Math.max(newest, band.validThroughMs);
  return Number.isFinite(newest) ? newest : undefined;
}
