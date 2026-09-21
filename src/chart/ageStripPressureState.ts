import type { TokenBook } from "@/lib/orderBook";
import { PressureMemory, type PressureCell } from "@/lib/pressureMemory";
import { signedVolumeSegments } from "@/lib/signedVolume";

export interface AgeStripPressureTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
}

interface PressureState extends AgeStripPressureTiming {
  readonly memory: PressureMemory;
}

/**
 * Shared pressure/history state for age-strip rows.
 *
 * Both ordinary event cards and recurring-series rows use this store so live
 * book updates, recorder hydration, resolution clearing, and ghost history
 * have exactly the same semantics.
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
        memory: new PressureMemory(),
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
      state.memory.restore(cells);

      // A websocket snapshot may have arrived before recorder hydration.
      // Paint the current book last so live pressure wins over persisted ghosts.
      const book = getBook(tokenId);
      if (book) state.memory.observe(signedVolumeSegments(book), nowMs);
    }
  }

  observeBook(
    tokenId: string,
    book: TokenBook<string>,
    nowMs = Date.now(),
  ): void {
    this.ensure(tokenId).memory.observe(signedVolumeSegments(book), nowMs);
  }

  resolve(tokenId: string): void {
    const state = this.states.get(tokenId);
    if (!state) return;

    // Resolution has its own semantic rendering. Keeping the former live book
    // as a fading ghost both obscures that result and makes resolved rows keep
    // participating in the ghost animation loop.
    state.memory.restore([]);
  }

  cells(tokenId: string): readonly PressureCell[] {
    return this.states.get(tokenId)?.memory.snapshot() ?? [];
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
