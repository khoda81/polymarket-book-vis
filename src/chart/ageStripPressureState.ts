import type { TokenBook } from "@/lib/orderBook";
import {
  PressureFrontierMemory,
  type PressureBookSide,
} from "@/lib/pressureFrontierMemory";
import type { PressureFrontierSnapshot } from "@/lib/pressureFrontierSnapshot";
import type { Price } from "@/lib/price";
import type { LiveBookUpdate } from "./liveBookFeed";

export interface AgeStripPressureTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
  readonly validThroughMs: number | null;
}

interface PressureState extends AgeStripPressureTiming {
  readonly memory: PressureFrontierMemory;
}

/** Shared timestamped pressure history for age-strip rows. */
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

      // A newer websocket book may have arrived before recorder hydration.
      const book = getBook(tokenId);
      if (book && state.validThroughMs !== null)
        state.memory.observeBook(book, state.validThroughMs);
    }
  }

  applyBookUpdate(
    tokenId: string,
    book: TokenBook,
    update: LiveBookUpdate,
  ): void {
    let state = this.ensure(tokenId);
    if (
      state.validThroughMs === null ||
      update.validThroughMs > state.validThroughMs
    ) {
      state = { ...state, validThroughMs: update.validThroughMs };
      this.states.set(tokenId, state);
    }

    const memory = state.memory;
    if (update.kind === "snapshot") {
      memory.observeBook(book, update.validThroughMs);
      return;
    }

    const bySide: Record<
      PressureBookSide,
      Array<{ price: Price; shares: number }>
    > = {
      bid: [],
      ask: [],
    };
    for (const change of update.changes)
      bySide[change.side].push({
        price: change.price,
        shares: change.shares,
      });

    memory.updateBookLevels(bySide.bid, bySide.ask, update.validThroughMs);
  }

  resolve(tokenId: string): void {
    this.states.get(tokenId)?.memory.clear();
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
    return (
      this.states.get(tokenId)?.memory.hasVisiblePressure(nowMs, halfLifeMs) ??
      false
    );
  }
}
