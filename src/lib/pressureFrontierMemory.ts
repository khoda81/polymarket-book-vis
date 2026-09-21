import type { TokenBook } from "./orderBook";
import {
  buildFrontier,
  frontierLevel,
  frontierLevels,
  frontierVolumeAt,
  setFrontierLevel,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import {
  ghostVisibleSinceMs,
  parsePressureCells,
  type PressureBand,
  type PressureCell,
  type PressureSide,
} from "./pressureMemory";

export type PressureBookSide = "bid" | "ask";

export interface PressureLevelChange {
  readonly price: number;
  readonly shares: number;
}

interface HistoricalFrontier {
  readonly sinceMs: number;
  readonly root: FrontierRoot;
}

interface SideFrontierState {
  current: FrontierRoot;
  updatedAtMs: number;
  history: HistoricalFrontier[];
}

/**
 * Pressure history represented as two side-local monotone frontier processes.
 *
 * For bids, u = price. For asks, u = 1 - price. On either side, a non-negative
 * price-level atom contributes to Q(u) for every u <= atom.key, therefore the
 * live pressure frontier Q is non-increasing by construction.
 *
 * A decrease stores the previous persistent frontier as one historical layer.
 * Rendering/querying walks historical frontiers newest-to-oldest and exposes
 * only radial extent not already covered by newer state. This is exactly the
 * "latest occupancy wins" rule, without overlapping semantic bands in storage.
 */
export class PressureFrontierMemory {
  private readonly bid: SideFrontierState = emptySideState();
  private readonly ask: SideFrontierState = emptySideState();
  private lastUpdateMs: number | undefined;
  private readonly priceKeys = new Set<number>([0, 1]);
  private cachedCells: readonly PressureCell[] | null = null;
  private cachedPriceBoundaries: readonly number[] | null = null;

  observeBook(book: TokenBook<unknown>, nowMs: number): void {
    this.validateTime(nowMs);

    this.replaceSide(
      this.bid,
      "bid",
      [...book.usdToYes.asOrders()]
        .filter(validBookOrder)
        .map((order) => ({ key: order.price, weight: order.take })),
      nowMs,
    );
    this.replaceSide(
      this.ask,
      "ask",
      [...book.yesToUsd.asSellOrders()]
        .filter(validBookOrder)
        .map((order) => ({ key: 1 - order.price, weight: order.take })),
      nowMs,
    );

    this.lastUpdateMs = nowMs;
    this.invalidateCells();
  }

  updateLevels(
    side: PressureBookSide,
    changes: readonly PressureLevelChange[],
    nowMs: number,
  ): void {
    this.validateTime(nowMs);
    const state = this.sideState(side);

    const finalByKey = new Map<number, number>();
    for (const change of changes) {
      const key = localKey(side, change.price);
      if (key === null) continue;
      if (!Number.isFinite(change.shares) || change.shares < 0) continue;
      finalByKey.set(key, change.shares);
      this.rememberPrice(change.price);
    }
    if (finalByKey.size === 0) {
      this.lastUpdateMs = nowMs;
      return;
    }

    const previous = state.current;
    let next = previous;
    let decreased = false;
    for (const [key, shares] of finalByKey) {
      if (shares < frontierLevel(previous, key)) decreased = true;
      next = setFrontierLevel(next, key, shares);
    }

    if (next !== previous) {
      if (decreased && previous)
        state.history.unshift({ sinceMs: nowMs, root: previous });
      state.current = next;
      state.updatedAtMs = nowMs;
      this.invalidateCells();
    }
    this.lastUpdateMs = nowMs;
  }

  /**
   * Restore the legacy persisted cell format into monotone side frontiers.
   *
   * Hidden portions of a historical frontier were intentionally discarded by
   * the old representation. The minimal monotone majorant reconstructs only
   * the hidden extent required by the frontier invariant; newer layers already
   * cover those points, so this does not change the visible semantic field.
   */
  restoreLegacyCells(value: unknown): void {
    const cells = parsePressureCells(value);
    this.clear();

    for (const cell of cells) {
      this.rememberPrice(cell.lo);
      this.rememberPrice(cell.hi);
    }

    const bidCurrent = frontierFromLegacyCells(cells, 1, "live");
    const askCurrent = frontierFromLegacyCells(cells, -1, "live");
    this.bid.current = bidCurrent;
    this.ask.current = askCurrent;

    const ghostTimes = new Set<number>();
    for (const cell of cells)
      for (const band of cell.bands)
        if (band.state.kind === "ghost")
          ghostTimes.add(band.state.sinceMs);

    const newestFirst = [...ghostTimes].sort((a, b) => b - a);
    for (const sinceMs of newestFirst) {
      const bid = frontierFromLegacyCells(cells, 1, sinceMs);
      if (bid) this.bid.history.push({ sinceMs, root: bid });
      const ask = frontierFromLegacyCells(cells, -1, sinceMs);
      if (ask) this.ask.history.push({ sinceMs, root: ask });
    }

    this.lastUpdateMs = newestFirst[0];
    this.invalidateCells();
  }

  priceBoundaries(): readonly number[] {
    if (this.cachedPriceBoundaries) return this.cachedPriceBoundaries;

    this.cachedPriceBoundaries = [...this.priceKeys].sort((a, b) => a - b);
    return this.cachedPriceBoundaries;
  }

  /**
   * Cached compatibility projection for the existing cell renderer.
   *
   * This is deliberately a migration seam. The framebuffer renderer should
   * consume frontier history directly and delete this projection.
   */
  cells(): readonly PressureCell[] {
    if (this.cachedCells) return this.cachedCells;

    const sorted = this.priceBoundaries();
    const cells: PressureCell[] = [];

    for (let index = 0; index + 1 < sorted.length; index++) {
      const lo = sorted[index]!;
      const hi = sorted[index + 1]!;
      if (!(hi > lo)) continue;
      const bands = this.shellsAtPrice((lo + hi) / 2);
      const previous = cells[cells.length - 1];

      if (previous && bandsEqual(previous.bands, bands)) {
        cells[cells.length - 1] = {
          lo: previous.lo,
          hi,
          bands: previous.bands,
        };
      } else {
        cells.push({ lo, hi, bands });
      }
    }

    this.cachedCells = cells;
    return cells;
  }

  /**
   * Exact semantic shells at one canonical YES price.
   *
   * The result is a contiguous radial prefix. Every point belongs to exactly
   * one newest state, so callers never need to composite overlapping history.
   */
  shellsAtPrice(
    price: number,
    visibleGhostSinceMs = Number.NEGATIVE_INFINITY,
  ): readonly PressureBand[] {
    if (!Number.isFinite(price)) return [];
    const p = clamp01(price);

    const bidLive = frontierVolumeAt(this.bid.current, p);
    const askLive = frontierVolumeAt(this.ask.current, 1 - p);
    const shells: PressureBand[] = [];

    let covered = 0;
    if (bidLive > 0 || askLive > 0) {
      const useBid =
        bidLive > 0 &&
        (!(askLive > 0) || this.bid.updatedAtMs >= this.ask.updatedAtMs);
      const liveVolume = useBid ? bidLive : askLive;
      shells.push({
        loVolume: 0,
        hiVolume: liveVolume,
        side: useBid ? 1 : -1,
        state: { kind: "live" },
      });
      covered = liveVolume;
    }

    let bidIndex = 0;
    let askIndex = 0;
    while (
      bidIndex < this.bid.history.length ||
      askIndex < this.ask.history.length
    ) {
      const bid = this.bid.history[bidIndex];
      const ask = this.ask.history[askIndex];
      if (
        (bid?.sinceMs ?? Number.NEGATIVE_INFINITY) <= visibleGhostSinceMs &&
        (ask?.sinceMs ?? Number.NEGATIVE_INFINITY) <= visibleGhostSinceMs
      )
        break;

      const takeBid =
        !!bid &&
        (!ask ||
          bid.sinceMs > ask.sinceMs ||
          (bid.sinceMs === ask.sinceMs && bidIndex <= askIndex));
      const layer = takeBid ? bid! : ask!;
      if (layer.sinceMs <= visibleGhostSinceMs) {
        if (takeBid) bidIndex++;
        else askIndex++;
        continue;
      }
      const side: PressureSide = takeBid ? 1 : -1;
      const u = takeBid ? p : 1 - p;
      const volume = frontierVolumeAt(layer.root, u);

      if (volume > covered) {
        appendBand(shells, {
          loVolume: covered,
          hiVolume: volume,
          side,
          state: { kind: "ghost", sinceMs: layer.sinceMs },
        });
        covered = volume;
      }

      if (takeBid) bidIndex++;
      else askIndex++;
    }

    return shells;
  }

  hasGhosts(): boolean {
    return this.bid.history.length > 0 || this.ask.history.length > 0;
  }

  hasVisibleGhosts(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 1 / 255,
  ): boolean {
    const cutoff = ghostVisibleSinceMs(nowMs, halfLifeMs, minAlpha);
    return (
      (this.bid.history[0]?.sinceMs ?? Number.NEGATIVE_INFINITY) > cutoff ||
      (this.ask.history[0]?.sinceMs ?? Number.NEGATIVE_INFINITY) > cutoff
    );
  }

  prune(nowMs: number, halfLifeMs: number, minAlpha = 0.01): void {
    const cutoff = ghostVisibleSinceMs(nowMs, halfLifeMs, minAlpha);
    const bidLength = this.bid.history.length;
    const askLength = this.ask.history.length;
    this.bid.history = this.bid.history.filter(
      (layer) => layer.sinceMs > cutoff,
    );
    this.ask.history = this.ask.history.filter(
      (layer) => layer.sinceMs > cutoff,
    );
    if (
      bidLength !== this.bid.history.length ||
      askLength !== this.ask.history.length
    )
      this.invalidateCells();
  }

  clear(): void {
    this.bid.current = null;
    this.bid.updatedAtMs = Number.NEGATIVE_INFINITY;
    this.bid.history = [];
    this.ask.current = null;
    this.ask.updatedAtMs = Number.NEGATIVE_INFINITY;
    this.ask.history = [];
    this.lastUpdateMs = undefined;
    this.priceKeys.clear();
    this.priceKeys.add(0);
    this.priceKeys.add(1);
    this.cachedCells = null;
    this.cachedPriceBoundaries = null;
  }

  private invalidateCells(): void {
    this.cachedCells = null;
  }

  /** Debug/test view of the current side-local atoms. */
  currentLevels(side: PressureBookSide): readonly FrontierLevel[] {
    return frontierLevels(this.sideState(side).current);
  }

  historyDepth(side: PressureBookSide): number {
    return this.sideState(side).history.length;
  }

  private replaceSide(
    state: SideFrontierState,
    side: PressureBookSide,
    levels: readonly FrontierLevel[],
    nowMs: number,
  ): void {
    const normalized = normalizeLevels(levels);
    for (const level of normalized)
      this.rememberPrice(side === "bid" ? level.key : 1 - level.key);
    const previousLevels = frontierLevels(state.current);
    if (levelsEqual(previousLevels, normalized)) return;

    const next = buildFrontier(normalized);
    if (state.current && frontierLostAtoms(previousLevels, normalized))
      state.history.unshift({ sinceMs: nowMs, root: state.current });

    state.current = next;
    state.updatedAtMs = nowMs;
  }

  private rememberPrice(price: number): void {
    if (!Number.isFinite(price) || price < 0 || price > 1) return;
    if (this.priceKeys.has(price)) return;
    this.priceKeys.add(price);
    this.cachedPriceBoundaries = null;
    this.cachedCells = null;
  }

  private sideState(side: PressureBookSide): SideFrontierState {
    return side === "bid" ? this.bid : this.ask;
  }

  private validateTime(nowMs: number): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("pressure frontier timestamp must be finite");
    if (this.lastUpdateMs !== undefined && nowMs < this.lastUpdateMs)
      throw new RangeError("pressure frontier timestamps must be monotonic");
  }
}

function emptySideState(): SideFrontierState {
  return {
    current: null,
    updatedAtMs: Number.NEGATIVE_INFINITY,
    history: [],
  };
}

function validBookOrder(order: {
  readonly price: number;
  readonly take: number;
}): boolean {
  return (
    Number.isFinite(order.price) &&
    order.price >= 0 &&
    order.price <= 1 &&
    Number.isFinite(order.take) &&
    order.take > 0
  );
}

function localKey(
  side: PressureBookSide,
  canonicalPrice: number,
): number | null {
  if (
    !Number.isFinite(canonicalPrice) ||
    canonicalPrice < 0 ||
    canonicalPrice > 1
  )
    return null;
  return side === "bid" ? canonicalPrice : 1 - canonicalPrice;
}

function normalizeLevels(levels: readonly FrontierLevel[]): FrontierLevel[] {
  const byKey = new Map<number, number>();
  for (const { key, weight } of levels) {
    if (
      !Number.isFinite(key) ||
      key < 0 ||
      key > 1 ||
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
        level.key === b[index]!.key &&
        level.weight === b[index]!.weight,
    )
  );
}

function frontierLostAtoms(
  previous: readonly FrontierLevel[],
  next: readonly FrontierLevel[],
): boolean {
  let i = 0;
  let j = 0;

  while (i < previous.length) {
    const before = previous[i]!;
    while (j < next.length && next[j]!.key < before.key) j++;
    const after =
      j < next.length && next[j]!.key === before.key
        ? next[j]!.weight
        : 0;
    if (after < before.weight) return true;
    i++;
  }
  return false;
}

function appendBand(bands: PressureBand[], band: PressureBand): void {
  const previous = bands[bands.length - 1];
  if (
    previous &&
    previous.hiVolume === band.loVolume &&
    previous.side === band.side &&
    previous.state.kind === "ghost" &&
    band.state.kind === "ghost" &&
    previous.state.sinceMs === band.state.sinceMs
  ) {
    bands[bands.length - 1] = {
      ...previous,
      hiVolume: band.hiVolume,
    };
    return;
  }
  bands.push(band);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}


type LegacyState = "live" | number;

function frontierFromLegacyCells(
  cells: readonly PressureCell[],
  side: PressureSide,
  state: LegacyState,
): FrontierRoot {
  const localSamples = cells.map((cell) => {
    const band = cell.bands.find(
      (candidate) =>
        candidate.side === side &&
        (state === "live"
          ? candidate.state.kind === "live"
          : candidate.state.kind === "ghost" &&
            candidate.state.sinceMs === state),
    );
    const lo = side > 0 ? cell.lo : 1 - cell.hi;
    const hi = side > 0 ? cell.hi : 1 - cell.lo;
    return {
      lo,
      hi,
      lowerBound: band?.hiVolume ?? 0,
    };
  });

  const boundaries = new Set<number>([0, 1]);
  for (const sample of localSamples) {
    boundaries.add(sample.lo);
    boundaries.add(sample.hi);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const values = new Array<number>(Math.max(0, sorted.length - 1)).fill(0);

  for (let index = 0; index < values.length; index++) {
    const midpoint = (sorted[index]! + sorted[index + 1]!) / 2;
    const sample = localSamples.find(
      (candidate) => candidate.lo <= midpoint && midpoint < candidate.hi,
    );
    values[index] = sample?.lowerBound ?? 0;
  }

  // Minimal non-increasing majorant: hidden history is reconstructed only
  // where monotonicity proves it must have existed.
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

function bandsEqual(
  a: readonly PressureBand[],
  b: readonly PressureBand[],
): boolean {
  if (a === b) return true;
  return (
    a.length === b.length &&
    a.every((band, index) => {
      const other = b[index]!;
      return (
        band.loVolume === other.loVolume &&
        band.hiVolume === other.hiVolume &&
        band.side === other.side &&
        band.state.kind === other.state.kind &&
        (band.state.kind === "live" ||
          (other.state.kind === "ghost" &&
            band.state.sinceMs === other.state.sinceMs))
      );
    })
  );
}
