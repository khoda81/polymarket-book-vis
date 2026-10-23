import {
  observationTime,
  type ObservationTime,
} from "@/domain/pressure/observationClock";
import type { FeeSchedule } from "@/domain/books/feeSchedule";
import type { TokenBook } from "@/domain/books/orderBook";
import {
  FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT,
  pressureExtentContains,
  type PressureExtent,
  type PressureFieldBand,
} from "@/domain/pressure/pressureField";
import { PressureFrontierMemory } from "@/domain/pressure/pressureFrontierMemory";
import type { PressureFrontierSnapshot } from "@/domain/pressure/pressureFrontierSnapshot";
import type { Price } from "@/domain/books/price";
import {
  tokenPressureChanges,
  tokenPressureLevels,
} from "@/domain/pressure/pressureBookAdapter";
import type { LiveBookUpdate } from "../live/liveBookContracts";

/** Mutated only by AgeStripPressureState, which never hands the record out. */
interface PressureState {
  recordingSinceMs: number | null;
  validThroughMs: number | null;
  readonly memory: PressureFrontierMemory;
  /**
   * GPU/render projection of non-finite terminal geometry. The canonical
   * terminal state lives in PressureFrontierMemory v7.
   */
  extents: readonly PressureExtent[];
  extentRevision: number;
  /**
   * Recorder hydration can be causally ahead of the local websocket. While the
   * stream catches up, keep mutating its canonical raw book but do not replay
   * older deltas into the newer pressure frontier. The first live observation
   * at/after this barrier rebases pressure from the complete current book.
   */
  liveRebaseAfterMs: number | null;
}

/** Read access to a token's frontier; only this module mutates it. */
export type ReadonlyPressureFrontier = Omit<
  PressureFrontierMemory,
  | "observeLevels"
  | "updateLevels"
  | "replaceContinuous"
  | "observeThrough"
  | "resolveUnbounded"
  | "resolveZeroFuture"
  | "restore"
>;

/** Token-local timestamped pressure histories used by age views. */
export class AgeStripPressureState {
  private readonly states = new Map<string, PressureState>();

  reset(): void {
    this.states.clear();
  }

  /** Start a token's history if it has none. */
  ensure(tokenId: string): void {
    this.state(tokenId);
  }

  has(tokenId: string): boolean {
    return this.states.has(tokenId);
  }

  private state(tokenId: string): PressureState {
    let state = this.states.get(tokenId);
    if (!state) {
      state = {
        recordingSinceMs: null,
        validThroughMs: null,
        memory: new PressureFrontierMemory(),
        extents: [],
        extentRevision: 0,
        liveRebaseAfterMs: null,
      };
      this.states.set(tokenId, state);
    }
    return state;
  }

  retain(tokenIds: ReadonlySet<string>): void {
    for (const tokenId of this.states.keys())
      if (!tokenIds.has(tokenId)) this.states.delete(tokenId);
  }

  setExtents(tokenId: string, extents: readonly PressureExtent[]): void {
    const state = this.state(tokenId);
    if (pressureExtentsEqual(state.extents, extents)) return;
    state.extents = [...extents];
    state.extentRevision++;
  }

  renderExtents(tokenId: string): readonly PressureExtent[] {
    return this.states.get(tokenId)?.extents ?? [];
  }

  renderExtentRevision(tokenId: string): number {
    return this.states.get(tokenId)?.extentRevision ?? 0;
  }

  bandAtPoint(
    tokenId: string,
    price: Price,
    volume: number,
  ): PressureFieldBand | undefined {
    const state = this.states.get(tokenId);
    if (!state) return undefined;

    for (let index = state.extents.length - 1; index >= 0; index--) {
      const extent = state.extents[index]!;
      if (!pressureExtentContains(extent, price, volume)) continue;
      return {
        loVolume: extent.loVolume,
        hiVolume: extent.hiVolume,
        validity: extent.validity,
      };
    }

    const band = state.memory.bandAtPoint(price, volume);
    return band
      ? {
          loVolume: band.loVolume,
          hiVolume: { kind: "finite", shares: band.hiVolume },
          validity: {
            kind: "through",
            validThroughMs: band.validThroughMs,
          },
        }
      : undefined;
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    for (const [tokenId, since] of Object.entries(recordingSinceMsByToken))
      this.state(tokenId).recordingSinceMs = since;
  }

  hydrate(
    snapshotsByToken: Readonly<Record<string, PressureFrontierSnapshot>>,
    getBook: (tokenId: string) => TokenBook | undefined,
    getFeeSchedule: (tokenId: string) => FeeSchedule,
  ): void {
    for (const [tokenId, snapshot] of Object.entries(snapshotsByToken)) {
      const state = this.state(tokenId);
      state.memory.restore(snapshot);

      if (state.memory.isResolvedUnbounded()) {
        this.setExtents(tokenId, [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);
        continue;
      }

      // A newer local websocket book may have arrived before recorder
      // hydration. Overlay it only when it is at least as new. Otherwise the
      // raw book keeps ingesting websocket deltas while pressure waits behind
      // a causal catch-up barrier, then rebases from that complete live book.
      const book = getBook(tokenId);
      const restoredThrough = state.memory.validThroughMs();
      if (
        book &&
        state.validThroughMs !== null &&
        (restoredThrough === undefined ||
          state.validThroughMs >= restoredThrough)
      ) {
        state.memory.observeLevels(
          tokenPressureLevels(book, getFeeSchedule(tokenId)),
          state.validThroughMs,
        );
        state.liveRebaseAfterMs = null;
      } else if (
        restoredThrough !== undefined &&
        (state.validThroughMs === null ||
          state.validThroughMs < restoredThrough)
      ) {
        state.liveRebaseAfterMs = restoredThrough;
      }
    }
  }

  applyBookUpdate(
    tokenId: string,
    book: TokenBook,
    schedule: FeeSchedule,
    update: LiveBookUpdate,
  ): void {
    const state = this.state(tokenId);
    if (state.memory.isResolvedUnbounded()) return;

    const currentThrough = state.memory.validThroughMs();
    const validThroughMs = update.validThroughMs;

    if (state.validThroughMs === null || validThroughMs > state.validThroughMs)
      state.validThroughMs = validThroughMs;

    if (currentThrough !== undefined && validThroughMs < currentThrough) {
      // This commonly happens for a few milliseconds when recorder hydration
      // wins the race against the local websocket. Do not force the newer
      // pressure frontier backward. The coordinator has already applied this
      // event to the canonical raw book, so a later catch-up can rebase safely.
      state.liveRebaseAfterMs = Math.max(
        state.liveRebaseAfterMs ?? currentThrough,
        currentThrough,
      );
      return;
    }

    if (
      state.liveRebaseAfterMs !== null &&
      validThroughMs >= state.liveRebaseAfterMs
    ) {
      state.memory.observeLevels(
        tokenPressureLevels(book, schedule),
        validThroughMs,
      );
      state.liveRebaseAfterMs = null;
      return;
    }

    if (update.kind === "snapshot") {
      state.memory.observeLevels(
        tokenPressureLevels(book, schedule),
        validThroughMs,
      );
      return;
    }
    if (update.kind === "replace") {
      state.memory.replaceContinuous(
        tokenPressureLevels(book, schedule),
        validThroughMs,
      );
      return;
    }
    if (update.kind === "watermark") {
      state.memory.observeThrough(validThroughMs);
      return;
    }

    state.memory.updateLevels(
      tokenPressureChanges(book, update.changes, schedule),
      validThroughMs,
    );
  }

  resolveSource(
    tokenId: string,
    unbounded: boolean,
    resolvedAtMs: number | null,
  ): void {
    const state = this.state(tokenId);
    if (unbounded) {
      state.memory.resolveUnbounded();
      this.setExtents(tokenId, [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);
    } else {
      state.memory.resolveZeroFuture(resolvedAtMs);
      this.setExtents(tokenId, []);
    }
  }

  memory(tokenId: string): ReadonlyPressureFrontier | undefined {
    return this.states.get(tokenId)?.memory;
  }

  recordingSinceMs(tokenId: string): number | null | undefined {
    return this.states.get(tokenId)?.recordingSinceMs;
  }

  observationTime(tokenId: string): ObservationTime | undefined {
    const timestamp = this.states.get(tokenId)?.memory.validThroughMs();
    return timestamp === undefined ? undefined : observationTime(timestamp);
  }
}

function pressureExtentsEqual(
  a: readonly PressureExtent[],
  b: readonly PressureExtent[],
): boolean {
  return (
    a.length === b.length &&
    a.every((extent, index) => {
      const other = b[index]!;
      return (
        extent.priceLo === other.priceLo &&
        extent.priceHi === other.priceHi &&
        extent.loVolume === other.loVolume &&
        extent.hiVolume.kind === other.hiVolume.kind &&
        (extent.hiVolume.kind === "unbounded" ||
          (other.hiVolume.kind === "finite" &&
            extent.hiVolume.shares === other.hiVolume.shares)) &&
        extent.validity.kind === other.validity.kind &&
        (extent.validity.kind === "persistent" ||
          (other.validity.kind === "through" &&
            extent.validity.validThroughMs === other.validity.validThroughMs))
      );
    })
  );
}
