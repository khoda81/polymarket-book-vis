import type { TokenBook } from "@/lib/orderBook";
import {
  PressureFrontierMemory,
  type PressureBookSide,
} from "@/lib/pressureFrontierMemory";
import type { PressureCell } from "@/lib/pressureMemory";
import type { LiveBookUpdate } from "./liveBookFeed";

export interface AgeStripPressureTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
}

interface PressureState extends AgeStripPressureTiming {
  readonly memory: PressureFrontierMemory;
}

/**
 * Shared pressure/history state for age-strip rows.
 *
 * The live state is a pair of monotone side-local cumulative frontiers. Normal
 * websocket level changes update those frontiers directly; the old PressureCell
 * format survives only as recorder hydration and renderer compatibility seams.
 */
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
        memory: new PressureFrontierMemory(),
      };
      this.states.set(tokenId, state);
    } else if (
      resolutionMs !== null &&
      Number.isFinite(resolutionMs) &&
      state.resolutionMs !== resolutionMs
    ) {
      state = {
        ...state,
        resolutionMs,
      };
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
    cellsByToken: Readonly<Record<string, readonly PressureCell[]>>,
    getBook: (tokenId: string) => TokenBook<string> | undefined,
    nowMs = Date.now(),
  ): void {
    for (const [tokenId, cells] of Object.entries(cellsByToken)) {
      const state = this.ensure(tokenId);
      state.memory.restoreLegacyCells(cells);

      // A websocket snapshot may have arrived before recorder hydration.
      // Paint the current book last so live pressure wins over persisted ghosts.
      const book = getBook(tokenId);
      if (book) state.memory.observeBook(book, nowMs);
    }
  }

  observeBook(
    tokenId: string,
    book: TokenBook<string>,
    nowMs = Date.now(),
  ): void {
    this.ensure(tokenId).memory.observeBook(book, nowMs);
  }

  applyBookUpdate(
    tokenId: string,
    book: TokenBook<string>,
    update: LiveBookUpdate,
  ): void {
    const memory = this.ensure(tokenId).memory;
    if (update.kind === "snapshot") {
      memory.observeBook(book, update.observedAtMs);
      return;
    }

    const bySide: Record<
      PressureBookSide,
      Array<{ price: number; shares: number }>
    > = {
      bid: [],
      ask: [],
    };
    for (const change of update.changes)
      bySide[change.side].push({
        price: change.price,
        shares: change.shares,
      });

    if (bySide.bid.length > 0)
      memory.updateLevels("bid", bySide.bid, update.observedAtMs);
    if (bySide.ask.length > 0)
      memory.updateLevels("ask", bySide.ask, update.observedAtMs);
  }

  resolve(tokenId: string): void {
    this.states.get(tokenId)?.memory.clear();
  }

  cells(tokenId: string): readonly PressureCell[] {
    return this.states.get(tokenId)?.memory.cells() ?? [];
  }

  memory(tokenId: string): PressureFrontierMemory | undefined {
    return this.states.get(tokenId)?.memory;
  }

  timing(tokenId: string): AgeStripPressureTiming | undefined {
    return this.states.get(tokenId);
  }

  hasVisibleGhosts(
    tokenId: string,
    nowMs: number,
    halfLifeMs: number,
  ): boolean {
    return (
      this.states.get(tokenId)?.memory.hasVisibleGhosts(nowMs, halfLifeMs) ??
      false
    );
  }
}
