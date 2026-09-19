import type { TokenBook } from "@/lib/orderBook";
import {
  PressureMemory,
  type PressureCell,
} from "@/lib/pressureMemory";
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
 *
 * Websocket deltas can arrive much faster than the display can paint them.
 * Queueing the latest book per token lets a draw consume one coherent state
 * per animation frame instead of rebuilding pressure memory for invisible
 * intermediate websocket states.
 */
export class AgeStripPressureState {
  private readonly states = new Map<string, PressureState>();
  private readonly pendingBooks = new Map<string, TokenBook<string>>();

  reset(): void {
    this.states.clear();
    this.pendingBooks.clear();
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
    this.pendingBooks.clear();
    for (const row of rows)
      this.ensure(row.tokenId, row.resolutionMs);
  }

  retain(tokenIds: ReadonlySet<string>): void {
    for (const tokenId of this.states.keys())
      if (!tokenIds.has(tokenId)) this.states.delete(tokenId);
    for (const tokenId of this.pendingBooks.keys())
      if (!tokenIds.has(tokenId)) this.pendingBooks.delete(tokenId);
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    for (const [tokenId, since] of Object.entries(recordingSinceMsByToken)) {
      const current = this.ensure(tokenId);
      this.states.set(tokenId, {
        ...current,
        recordingSinceMs:
          Number.isFinite(since) && since >= 0 ? since : null,
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

      // A websocket snapshot may have beaten recorder hydration. Repaint
      // the newest local book last so current liquidity wins over persisted
      // ghosts, then remove the redundant queued observation.
      const book =
        this.pendingBooks.get(tokenId) ??
        getBook(tokenId);
      if (book) {
        state.memory.observe(
          signedVolumeSegments(book),
          nowMs,
        );
        this.pendingBooks.delete(tokenId);
      }
    }
  }

  queueBookUpdate(
    tokenId: string,
    book: TokenBook<string>,
  ): void {
    this.ensure(tokenId);
    this.pendingBooks.set(tokenId, book);
  }

  flushBookUpdates(nowMs = Date.now()): void {
    if (this.pendingBooks.size === 0) return;

    for (const [tokenId, book] of this.pendingBooks) {
      this.ensure(tokenId).memory.observe(
        signedVolumeSegments(book),
        nowMs,
      );
    }
    this.pendingBooks.clear();
  }

  resolve(tokenId: string, nowMs = Date.now()): void {
    const state = this.states.get(tokenId);
    if (!state) return;

    const pending = this.pendingBooks.get(tokenId);
    if (pending) {
      state.memory.observe(
        signedVolumeSegments(pending),
        nowMs,
      );
      this.pendingBooks.delete(tokenId);
    }

    state.memory.observe(
      [{ lo: 0, hi: 1, volume: 0 }],
      nowMs,
    );
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
      this.states.get(tokenId)?.memory.hasVisibleGhosts(
        nowMs,
        halfLifeMs,
      ) ?? false
    );
  }
}
