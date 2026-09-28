import type { TokenBook } from "@/lib/orderBook";
import {
  FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT,
  PRESSURE_MIN_VISIBLE_ALPHA,
  pressureExtentContains,
  pressureValidityAlpha,
  type PressureExtent,
  type PressureFieldBand,
} from "@/lib/pressureField";
import { PressureFrontierMemory } from "@/lib/pressureFrontierMemory";
import type { PressureFrontierSnapshot } from "@/lib/pressureFrontierSnapshot";
import type { Price } from "@/lib/price";
import {
  tokenPressureChanges,
  tokenPressureLevels,
} from "@/lib/pressureBookAdapter";
import type { LiveBookUpdate } from "./liveBookFeed";

export interface AgeStripPressureTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
  readonly validThroughMs: number | null;
}

interface PressureState extends AgeStripPressureTiming {
  readonly memory: PressureFrontierMemory;
  /**
   * GPU/render projection of non-finite terminal geometry. The canonical
   * terminal state lives in PressureFrontierMemory v7.
   */
  readonly extents: readonly PressureExtent[];
  readonly extentRevision: number;
}

/** Token-local timestamped pressure histories used by age views. */
export class AgeStripPressureState {
  private readonly states = new Map<string, PressureState>();

  reset(): void {
    this.states.clear();
  }

  ensure(tokenId: string, resolutionMs: number | null = null): PressureState {
    let state = this.states.get(tokenId);
    if (!state) {
      state = {
        recordingSinceMs: null,
        resolutionMs,
        validThroughMs: null,
        memory: new PressureFrontierMemory(),
        extents: [],
        extentRevision: 0,
      };
      this.states.set(tokenId, state);
    } else if (
      resolutionMs !== null &&
      Number.isFinite(resolutionMs) &&
      state.resolutionMs !== resolutionMs
    ) {
      state = { ...state, resolutionMs };
      this.states.set(tokenId, state);
    }
    return state;
  }

  configure(
    rows: readonly {
      readonly tokenId: string;
      readonly resolutionMs: number | null;
    }[],
  ): void {
    this.states.clear();
    for (const row of rows) this.ensure(row.tokenId, row.resolutionMs);
  }

  retain(tokenIds: ReadonlySet<string>): void {
    for (const tokenId of this.states.keys())
      if (!tokenIds.has(tokenId)) this.states.delete(tokenId);
  }

  setExtents(tokenId: string, extents: readonly PressureExtent[]): void {
    const current = this.ensure(tokenId);
    if (pressureExtentsEqual(current.extents, extents)) return;
    this.states.set(tokenId, {
      ...current,
      extents: [...extents],
      extentRevision: current.extentRevision + 1,
    });
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
    for (const [tokenId, since] of Object.entries(recordingSinceMsByToken)) {
      const current = this.ensure(tokenId);
      this.states.set(tokenId, {
        ...current,
        recordingSinceMs: Number.isFinite(since) && since >= 0 ? since : null,
      });
    }
  }

  hydrate(
    snapshotsByToken: Readonly<Record<string, PressureFrontierSnapshot>>,
    getBook: (tokenId: string) => TokenBook | undefined,
  ): void {
    for (const [tokenId, snapshot] of Object.entries(snapshotsByToken)) {
      const state = this.ensure(tokenId);
      try {
        state.memory.restore(snapshot);
      } catch (error) {
        console.warn(
          `Ignoring invalid recorder pressure for token ${tokenId}; preserving current pressure`,
          error,
        );
      }

      if (state.memory.isResolvedUnbounded()) {
        this.setExtents(tokenId, [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);
        continue;
      }

      // A newer local websocket book may have arrived before recorder
      // hydration. Only overlay it when its causal watermark is not older than
      // the restored recorder frontier; never max-stamp a stale snapshot.
      const book = getBook(tokenId);
      const restoredThrough = state.memory.validThroughMs();
      if (
        book &&
        state.validThroughMs !== null &&
        (restoredThrough === undefined ||
          state.validThroughMs >= restoredThrough)
      )
        state.memory.observeLevels(
          tokenPressureLevels(book),
          state.validThroughMs,
        );
    }
  }

  applyBookUpdate(
    tokenId: string,
    book: TokenBook,
    update: LiveBookUpdate,
  ): void {
    let state = this.ensure(tokenId);
    if (state.memory.isResolvedUnbounded()) return;

    const currentThrough = state.memory.validThroughMs();
    if (
      update.kind === "snapshot" &&
      currentThrough !== undefined &&
      update.validThroughMs < currentThrough
    )
      return;

    const validThroughMs =
      update.kind === "snapshot"
        ? update.validThroughMs
        : Math.max(currentThrough ?? update.validThroughMs, update.validThroughMs);

    if (
      state.validThroughMs === null ||
      validThroughMs > state.validThroughMs
    ) {
      state = { ...state, validThroughMs };
      this.states.set(tokenId, state);
    }

    if (update.kind === "snapshot") {
      state.memory.observeLevels(tokenPressureLevels(book), validThroughMs);
      return;
    }
    if (update.kind === "replace") {
      state.memory.replaceContinuous(tokenPressureLevels(book), validThroughMs);
      return;
    }
    if (update.kind === "watermark") {
      state.memory.observeThrough(validThroughMs);
      return;
    }

    state.memory.updateLevels(
      tokenPressureChanges(update.changes),
      validThroughMs,
    );
  }

  resolveSource(
    tokenId: string,
    unbounded: boolean,
    resolvedAtMs: number | null,
  ): void {
    const state = this.ensure(tokenId, resolvedAtMs);
    if (unbounded) {
      state.memory.resolveUnbounded(resolvedAtMs);
      this.setExtents(tokenId, [FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT]);
    } else {
      state.memory.resolveZeroFuture(resolvedAtMs);
      this.setExtents(tokenId, []);
    }
  }

  memory(tokenId: string): PressureFrontierMemory | undefined {
    return this.states.get(tokenId)?.memory;
  }

  timing(tokenId: string): AgeStripPressureTiming | undefined {
    return this.states.get(tokenId);
  }

  hasVisiblePressure(
    tokenId: string,
    nowMs: number,
    halfLifeMs: number,
  ): boolean {
    const state = this.states.get(tokenId);
    if (!state) return false;

    if (
      state.extents.some(
        (extent) =>
          pressureValidityAlpha(extent.validity, nowMs, halfLifeMs) >
          PRESSURE_MIN_VISIBLE_ALPHA,
      )
    )
      return true;

    return state.memory.hasVisiblePressure(nowMs, halfLifeMs);
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
