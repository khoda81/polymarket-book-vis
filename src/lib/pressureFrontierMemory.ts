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
import { ghostVisibleSinceMs, type PressureBand } from "./pressureField";
import { parsePressureCells, type PressureCell } from "./legacyPressureCells";
import {
  PRICE_ONE,
  PRICE_ZERO,
  complementPrice,
  type Price,
  priceFromLegacyNumber,
  priceFromTicks,
} from "./price";
import {
  parsePressureFrontierSnapshot,
  migrateLegacyCurrentSide,
  migrateLegacyField,
  restoreCurrentSide,
  restoreSnapshotSideV1,
  snapshotCurrentSide,
  type PressureFrontierSnapshot,
  type PressureFrontierSnapshotV1,
  type PressureFrontierSnapshotV3,
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
 * Current liquidity is stored as two immutable monotone cumulative frontiers.
 * Historical display state is maintained separately as an incrementally
 * materialized price × cumulative-volume field.
 *
 * A level mutation updates the atom tree in O(log n), derives the constant
 * cumulative delta induced over one canonical price prefix/suffix, and applies
 * that delta directly to the materialized runs. Rendering therefore never
 * reconstructs historical state from frontier snapshots.
 */
export class PressureFrontierMemory {
  private readonly bid: SideFrontierState = { current: null };
  private readonly ask: SideFrontierState = { current: null };
  private field = new MaterializedPressureField();
  private lastUpdateMs: number | undefined;

  observeBook(book: TokenBook, nowMs: number): void {
    nowMs = this.normalizeTime(nowMs);

    this.replaceSide(
      "bid",
      [...book.usdToYes.asOrders()]
        .filter(validBookOrder)
        .map((order) => ({ key: order.price, weight: order.take })),
      nowMs,
    );
    this.replaceSide(
      "ask",
      [...book.yesToUsd.asSellOrders()].filter(validBookOrder).map((order) => ({
        key: complementPrice(order.price),
        weight: order.take,
      })),
      nowMs,
    );

    this.lastUpdateMs = nowMs;
  }

  updateLevels(
    side: PressureBookSide,
    changes: readonly PressureLevelChange[],
    nowMs: number,
  ): void {
    nowMs = this.normalizeTime(nowMs);
    const state = this.sideState(side);

    const finalByKey = new Map<Price, number>();
    for (const change of changes) {
      const key = localKey(side, change.price);
      if (key === null) continue;
      if (!Number.isFinite(change.shares) || change.shares < 0) continue;
      finalByKey.set(key, change.shares);
    }

    if (finalByKey.size === 0) {
      this.lastUpdateMs = nowMs;
      return;
    }

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
      this.field.applySideDeltas(side, deltas, nowMs, next);
      state.current = next;
    }
    this.lastUpdateMs = nowMs;
  }

  snapshot(): PressureFrontierSnapshotV3 {
    return {
      version: 3,
      bid: snapshotCurrentSide(this.bid.current),
      ask: snapshotCurrentSide(this.ask.current),
      field: this.field.snapshot(),
    };
  }

  restore(snapshot: PressureFrontierSnapshot | unknown): void {
    const parsed = parsePressureFrontierSnapshot(snapshot);
    const restored = new PressureFrontierMemory();

    if (parsed.version === 3) {
      restored.bid.current = restoreCurrentSide(parsed.bid);
      restored.ask.current = restoreCurrentSide(parsed.ask);
      restored.field.restore(parsed.field);
      restored.validateFieldAgainstFrontiers(parsed.field.runs);
      restored.lastUpdateMs = newestGhostTime(parsed.field.runs);
    } else if (parsed.version === 2) {
      const bid = migrateLegacyCurrentSide(parsed.bid);
      const ask = migrateLegacyCurrentSide(parsed.ask);
      const field = migrateLegacyField(parsed.field);
      restored.bid.current = restoreCurrentSide(bid);
      restored.ask.current = restoreCurrentSide(ask);
      restored.field.restore(field);
      restored.validateFieldAgainstFrontiers(field.runs);
      restored.lastUpdateMs = newestGhostTime(field.runs);
    } else {
      restored.restoreV1(parsed);
    }

    // Commit only a fully validated snapshot. Failed hydration must leave the
    // live frontiers, historical bands, and observation clock intact.
    this.replaceWith(restored);
  }

  restoreLegacyCells(value: unknown): void {
    const cells = parsePressureCells(value);
    const restored = new PressureFrontierMemory();
    restored.restoreCells(cells);
    this.replaceWith(restored);
  }

  private replaceWith(restored: PressureFrontierMemory): void {
    this.bid.current = restored.bid.current;
    this.ask.current = restored.ask.current;
    this.field = restored.field;
    this.lastUpdateMs = restored.lastUpdateMs;
  }

  private restoreCells(cells: readonly PressureCell[]): void {
    this.bid.current = frontierFromLegacyCells(cells, 1, "live");
    this.ask.current = frontierFromLegacyCells(cells, -1, "live");

    const boundaries = new Set<Price>([PRICE_ZERO, PRICE_ONE]);
    for (const cell of cells) {
      boundaries.add(priceFromLegacyNumber(cell.lo));
      boundaries.add(priceFromLegacyNumber(cell.hi));
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    const runs: PressureFieldRunSnapshot[] = [];

    for (let index = 0; index + 1 < sorted.length; index++) {
      const lo = sorted[index]!;
      const hi = sorted[index + 1]!;
      if (!(hi > lo)) continue;
      const cell = cells.find(
        (candidate) =>
          priceFromLegacyNumber(candidate.lo) <= lo &&
          hi <= priceFromLegacyNumber(candidate.hi),
      );
      const bands = cell?.bands.map(cloneBand) ?? [];
      const bidVolume = liveExtent(bands, 1);
      const askVolume = liveExtent(bands, -1);
      const innerLive = bands.find((band) => band.state.kind === "live");

      runs.push({
        lo,
        hi,
        bidVolume,
        askVolume,
        bidRevision: bidVolume > 0 ? (innerLive?.side === 1 ? 2 : 1) : 0,
        askRevision: askVolume > 0 ? (innerLive?.side === -1 ? 2 : 1) : 0,
        bands,
      });
    }

    this.field.restoreRuns(runs.length > 0 ? runs : [emptyFieldRun()], 2);
    this.lastUpdateMs = newestGhostTime(runs);
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

  hasGhosts(): boolean {
    return this.field.hasGhosts();
  }

  hasVisibleGhosts(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    return this.field.hasVisibleGhosts(
      ghostVisibleSinceMs(nowMs, halfLifeMs, minAlpha),
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

  historyDepth(side: PressureBookSide): number {
    return this.field.ghostBandCount(side);
  }

  private replaceSide(
    side: PressureBookSide,
    levels: readonly FrontierLevel[],
    nowMs: number,
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
    this.field.applySideDeltas(side, deltas, nowMs, next);
    state.current = next;
  }

  private restoreV1(snapshot: PressureFrontierSnapshotV1): void {
    const bid = restoreSnapshotSideV1(snapshot.bid);
    const ask = restoreSnapshotSideV1(snapshot.ask);
    this.bid.current = bid.current;
    this.ask.current = ask.current;

    const boundaries = new Set<Price>([PRICE_ZERO, PRICE_ONE]);
    collectV1Boundaries(boundaries, bid, "bid");
    collectV1Boundaries(boundaries, ask, "ask");
    const sorted = [...boundaries].sort((a, b) => a - b);
    const revisions = legacySideRevisions(bid.updatedAtMs, ask.updatedAtMs);
    const runs: PressureFieldRunSnapshot[] = [];

    for (let index = 0; index + 1 < sorted.length; index++) {
      const lo = sorted[index]!;
      const hi = sorted[index + 1]!;
      if (!(hi > lo)) continue;
      runs.push({
        lo,
        hi,
        bidVolume: frontierVolumeOnInterval(bid.current, "bid", lo, hi),
        askVolume: frontierVolumeOnInterval(ask.current, "ask", lo, hi),
        bidRevision: revisions.bid,
        askRevision: revisions.ask,
        bands: legacyV1ShellsOnInterval(bid, ask, lo, hi),
      });
    }

    this.field.restoreRuns(runs.length > 0 ? runs : [emptyFieldRun()], 2);
    this.lastUpdateMs = Math.max(
      finiteOrNegativeInfinity(bid.updatedAtMs),
      finiteOrNegativeInfinity(ask.updatedAtMs),
      newestLegacyHistoryTime(bid.history),
      newestLegacyHistoryTime(ask.history),
    );
    if (!Number.isFinite(this.lastUpdateMs)) this.lastUpdateMs = undefined;
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

  private normalizeTime(nowMs: number): number {
    if (!Number.isFinite(nowMs))
      throw new RangeError("pressure frontier timestamp must be finite");

    return this.lastUpdateMs === undefined
      ? nowMs
      : Math.max(nowMs, this.lastUpdateMs);
  }
}

interface RestoredV1Side {
  readonly updatedAtMs: number;
  readonly current: FrontierRoot;
  readonly history: readonly {
    readonly sinceMs: number;
    readonly root: FrontierRoot;
  }[];
}

function collectV1Boundaries(
  boundaries: Set<Price>,
  side: RestoredV1Side,
  kind: PressureBookSide,
): void {
  const collect = (root: FrontierRoot) => {
    for (const { key } of frontierLevels(root))
      boundaries.add(kind === "bid" ? key : complementPrice(key));
  };
  collect(side.current);
  for (const layer of side.history) collect(layer.root);
}

function legacyV1ShellsOnInterval(
  bid: RestoredV1Side,
  ask: RestoredV1Side,
  lo: Price,
  hi: Price,
): PressureBand[] {
  const shells: PressureBand[] = [];
  const bidLive = frontierVolumeOnInterval(bid.current, "bid", lo, hi);
  const askLive = frontierVolumeOnInterval(ask.current, "ask", lo, hi);

  let covered = 0;
  if (bidLive > 0 || askLive > 0) {
    const useBid =
      bidLive > 0 && (!(askLive > 0) || bid.updatedAtMs >= ask.updatedAtMs);
    const liveVolume = useBid ? bidLive : askLive;
    appendBand(shells, {
      loVolume: 0,
      hiVolume: liveVolume,
      side: useBid ? 1 : -1,
      state: { kind: "live" },
    });
    covered = liveVolume;
  }

  let bidIndex = 0;
  let askIndex = 0;
  while (bidIndex < bid.history.length || askIndex < ask.history.length) {
    const bidLayer = bid.history[bidIndex];
    const askLayer = ask.history[askIndex];
    const takeBid =
      !!bidLayer &&
      (!askLayer ||
        bidLayer.sinceMs > askLayer.sinceMs ||
        (bidLayer.sinceMs === askLayer.sinceMs && bidIndex <= askIndex));
    const layer = takeBid ? bidLayer! : askLayer!;
    const volume = frontierVolumeOnInterval(
      layer.root,
      takeBid ? "bid" : "ask",
      lo,
      hi,
    );

    if (volume > covered) {
      appendBand(shells, {
        loVolume: covered,
        hiVolume: volume,
        side: takeBid ? 1 : -1,
        state: { kind: "ghost", sinceMs: layer.sinceMs },
      });
      covered = volume;
    }

    if (takeBid) bidIndex++;
    else askIndex++;
  }

  return shells;
}

function legacySideRevisions(
  bidUpdatedAtMs: number,
  askUpdatedAtMs: number,
): { bid: number; ask: number } {
  const bidFinite = Number.isFinite(bidUpdatedAtMs);
  const askFinite = Number.isFinite(askUpdatedAtMs);
  if (!bidFinite && !askFinite) return { bid: 0, ask: 0 };
  if (bidFinite && !askFinite) return { bid: 1, ask: 0 };
  if (!bidFinite && askFinite) return { bid: 0, ask: 1 };
  if (bidUpdatedAtMs >= askUpdatedAtMs) return { bid: 2, ask: 1 };
  return { bid: 1, ask: 2 };
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

function liveExtent(bands: readonly PressureBand[], side: 1 | -1): number {
  let extent = 0;
  for (const band of bands)
    if (band.side === side && band.state.kind === "live")
      extent = Math.max(extent, band.hiVolume);
  return extent;
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

function appendBand(bands: PressureBand[], band: PressureBand): void {
  const previous = bands[bands.length - 1];
  if (
    previous &&
    previous.hiVolume === band.loVolume &&
    previous.side === band.side &&
    statesEqual(previous, band)
  ) {
    bands[bands.length - 1] = {
      ...previous,
      hiVolume: band.hiVolume,
    };
    return;
  }
  bands.push(band);
}

function statesEqual(a: PressureBand, b: PressureBand): boolean {
  return (
    a.state.kind === b.state.kind &&
    (a.state.kind === "live" ||
      (b.state.kind === "ghost" && a.state.sinceMs === b.state.sinceMs))
  );
}

function frontierFromLegacyCells(
  cells: readonly PressureCell[],
  side: 1 | -1,
  state: "live",
): FrontierRoot {
  const localSamples = cells.map((cell) => {
    const band = cell.bands.find(
      (candidate) => candidate.side === side && candidate.state.kind === state,
    );
    const canonicalLo = priceFromLegacyNumber(cell.lo);
    const canonicalHi = priceFromLegacyNumber(cell.hi);
    const lo = side > 0 ? canonicalLo : complementPrice(canonicalHi);
    const hi = side > 0 ? canonicalHi : complementPrice(canonicalLo);
    return {
      lo,
      hi,
      lowerBound: band?.hiVolume ?? 0,
    };
  });

  const boundaries = new Set<Price>([PRICE_ZERO, PRICE_ONE]);
  for (const sample of localSamples) {
    boundaries.add(sample.lo);
    boundaries.add(sample.hi);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const values = new Array<number>(Math.max(0, sorted.length - 1)).fill(0);

  for (let index = 0; index < values.length; index++) {
    const lo = sorted[index]!;
    const hi = sorted[index + 1]!;
    const sample = localSamples.find(
      (candidate) => candidate.lo <= lo && hi <= candidate.hi,
    );
    values[index] = sample?.lowerBound ?? 0;
  }

  for (let index = values.length - 2; index >= 0; index--)
    values[index] = Math.max(values[index]!, values[index + 1]!);

  const levels: FrontierLevel[] = [];
  let outer = 0;
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]!;
    if (value > outer)
      levels.push({
        key: sorted[index + 1]!,
        weight: value - outer,
      });
    outer = value;
  }
  return buildFrontier(levels);
}

function newestGhostTime(
  runs: readonly { readonly bands: readonly PressureBand[] }[],
): number | undefined {
  let newest = Number.NEGATIVE_INFINITY;
  for (const run of runs)
    for (const band of run.bands)
      if (band.state.kind === "ghost")
        newest = Math.max(newest, band.state.sinceMs);
  return Number.isFinite(newest) ? newest : undefined;
}

function newestLegacyHistoryTime(
  history: readonly { readonly sinceMs: number }[],
): number {
  return history[0]?.sinceMs ?? Number.NEGATIVE_INFINITY;
}

function finiteOrNegativeInfinity(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function emptyFieldRun(): PressureFieldRunSnapshot {
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
