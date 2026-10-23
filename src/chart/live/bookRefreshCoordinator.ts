import {
  RateLimitError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import { MAX_TIMER_DELAY_MS } from "../../shared/timers";

const BOOKS_REQUEST_LIMIT = 500;
const BOOKS_REQUEST_WINDOW_MS = 10_000;
const BOOKS_REQUEST_SPACING_MS = BOOKS_REQUEST_WINDOW_MS / BOOKS_REQUEST_LIMIT;
// Temporary watchdog for Polymarket's silently-stalled market websocket.
// Keep this independent of ghost rendering precision: REST is evidence/liveness,
// not a display refresh mechanism. See #13.
export const STALE_BOOK_VERIFY_MS = 5_000;
const INITIAL_FAILURE_BACKOFF_MS = 1_000;
const MAX_FAILURE_BACKOFF_MS = 30_000;
const MAX_MISSING_BOOK_BACKOFF_MS = 60_000;

export type BookRefreshSnapshot = Awaited<
  ReturnType<PublicClient["fetchOrderBooks"]>
>[number];

export interface BookRefreshSubscriber {
  readonly onBookRefreshStarted: (
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
  ) => void;
  readonly onBookRefreshSnapshot: (
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
    snapshot: BookRefreshSnapshot,
  ) => void;
  /** A successful /books response omitted this token; it is not an empty book. */
  readonly onBookRefreshUnavailable?: (
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
  ) => void;
  readonly onBookRefreshFinished: (tokenId: TokenId, requestId: number) => void;
}

interface TokenRefreshState {
  readonly watchers: Map<BookRefreshSubscriber, number>;
  missingCount: number;
  retryAtMs: number;
}

interface RefreshHeapNode {
  readonly tokenId: TokenId;
  readonly deadlineMs: number;
}

interface BatchToken {
  readonly tokenId: TokenId;
  readonly watchers: readonly BookRefreshSubscriber[];
  readonly state: TokenRefreshState;
}

const coordinators = new WeakMap<PublicClient, BookRefreshCoordinator>();

export function bookRefreshCoordinator(
  client: PublicClient,
): BookRefreshCoordinator {
  let coordinator = coordinators.get(client);
  if (!coordinator) {
    coordinator = new BookRefreshCoordinator(client);
    coordinators.set(client, coordinator);
  }
  return coordinator;
}

/**
 * Process-wide stale-book refresh scheduler for one PublicClient.
 *
 * The shared LiveBookCoordinator reports each token's latest observation here.
 * Tokens live in one min-heap ordered by their next liveness-verification
 * deadline, so duplicate watches across charts collapse into one /books request.
 *
 * A token receiving websocket evidence continually pushes its deadline forward;
 * only books silent for STALE_BOOK_VERIFY_MS are verified over REST.
 */
export class BookRefreshCoordinator {
  private readonly states = new Map<TokenId, TokenRefreshState>();
  private readonly tokensBySubscriber = new Map<
    BookRefreshSubscriber,
    Set<TokenId>
  >();
  private readonly heap = new IndexedDeadlineHeap();
  private timer: number | undefined;
  private inFlight = false;
  private requestId = 0;
  private readonly requestTimesMs: number[] = [];
  private lastRequestAtMs = Number.NEGATIVE_INFINITY;
  private failureCount = 0;
  private backoffUntilMs = 0;

  constructor(private readonly client: PublicClient) {}

  observe(
    subscriber: BookRefreshSubscriber,
    tokenId: TokenId,
    validThroughMs: number,
  ): void {
    if (!Number.isFinite(validThroughMs) || validThroughMs < 0) return;

    let state = this.states.get(tokenId);
    if (!state) {
      state = {
        watchers: new Map(),
        missingCount: 0,
        retryAtMs: 0,
      };
      this.states.set(tokenId, state);
    }

    const previous = state.watchers.get(subscriber);
    if (previous === undefined || validThroughMs > previous) {
      state.watchers.set(subscriber, validThroughMs);
      // New book evidence ends an unavailable-book backoff. Merely repeating
      // the old observation must not bypass it.
      if (previous !== undefined) {
        state.missingCount = 0;
        state.retryAtMs = 0;
      }
    }

    let owned = this.tokensBySubscriber.get(subscriber);
    if (!owned) {
      owned = new Set();
      this.tokensBySubscriber.set(subscriber, owned);
    }
    owned.add(tokenId);

    this.reschedule(tokenId, state);
    this.schedulePump();
  }

  unwatch(subscriber: BookRefreshSubscriber, tokenId: TokenId): void {
    this.unwatchKey(subscriber, tokenId);
    this.schedulePump();
  }

  unwatchAll(subscriber: BookRefreshSubscriber): void {
    const tokenIds = this.tokensBySubscriber.get(subscriber);
    if (!tokenIds) return;

    for (const tokenId of [...tokenIds]) this.unwatchKey(subscriber, tokenId);
    this.tokensBySubscriber.delete(subscriber);
    this.schedulePump();
  }

  private unwatchKey(
    subscriber: BookRefreshSubscriber,
    tokenId: TokenId,
  ): void {
    const state = this.states.get(tokenId);
    if (!state) return;

    state.watchers.delete(subscriber);
    this.tokensBySubscriber.get(subscriber)?.delete(tokenId);

    if (state.watchers.size === 0) {
      this.states.delete(tokenId);
      this.heap.delete(tokenId);
    } else {
      this.reschedule(tokenId, state);
    }
  }

  private reschedule(tokenId: TokenId, state: TokenRefreshState): void {
    let oldestObservationMs = Number.POSITIVE_INFINITY;
    for (const observedThroughMs of state.watchers.values())
      oldestObservationMs = Math.min(oldestObservationMs, observedThroughMs);

    this.heap.set(
      tokenId,
      Math.max(oldestObservationMs + STALE_BOOK_VERIFY_MS, state.retryAtMs),
    );
  }

  private schedulePump(): void {
    if (this.inFlight) return;

    const next = this.heap.peek();
    if (!next) {
      this.cancelTimer();
      return;
    }

    const nowMs = Date.now();
    const wakeAtMs = Math.max(
      next.deadlineMs,
      this.nextRequestAllowedAtMs(nowMs),
      this.backoffUntilMs,
    );
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, wakeAtMs - nowMs));

    this.cancelTimer();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, delayMs);
  }

  private async pump(): Promise<void> {
    if (this.inFlight) return;

    const nowMs = Date.now();
    const next = this.heap.peek();
    if (!next) return;

    const allowedAtMs = Math.max(
      this.nextRequestAllowedAtMs(nowMs),
      this.backoffUntilMs,
    );
    if (next.deadlineMs > nowMs || allowedAtMs > nowMs) {
      this.schedulePump();
      return;
    }

    const batch = this.collectDue(nowMs);
    if (batch.length === 0) {
      this.schedulePump();
      return;
    }

    this.inFlight = true;
    const requestId = ++this.requestId;
    const requestedAtMs = Date.now();
    this.recordRequest(requestedAtMs);

    for (const token of batch)
      for (const watcher of token.watchers)
        watcher.onBookRefreshStarted(token.tokenId, requestId, requestedAtMs);

    try {
      const snapshots = await this.client.fetchOrderBooks(
        batch.map(({ tokenId }) => ({ assetId: tokenId })),
      );
      const snapshotByToken = new Map(
        snapshots.map((snapshot) => [snapshot.assetId, snapshot]),
      );

      for (const token of batch) {
        const current = this.states.get(token.tokenId);
        if (current !== token.state) continue;
        const snapshot = snapshotByToken.get(token.tokenId);
        current.missingCount = snapshot ? 0 : current.missingCount + 1;
        for (const watcher of token.watchers) {
          if (!current.watchers.has(watcher)) continue;
          if (snapshot)
            watcher.onBookRefreshSnapshot(
              token.tokenId,
              requestId,
              requestedAtMs,
              snapshot,
            );
          else
            watcher.onBookRefreshUnavailable?.(
              token.tokenId,
              requestId,
              requestedAtMs,
            );
        }
        // Set this after delivery: accepting a snapshot can synchronously
        // report a newer observation. A slow request's start timestamp must
        // not make its next check immediately overdue again.
        current.retryAtMs =
          Date.now() +
          (snapshot
            ? STALE_BOOK_VERIFY_MS
            : Math.min(
                MAX_MISSING_BOOK_BACKOFF_MS,
                STALE_BOOK_VERIFY_MS * 2 ** (current.missingCount - 1),
              ));
      }

      this.failureCount = 0;
      this.backoffUntilMs = 0;
    } catch (error) {
      this.failureCount++;
      const backoffMs = Math.min(
        MAX_FAILURE_BACKOFF_MS,
        INITIAL_FAILURE_BACKOFF_MS * 2 ** (this.failureCount - 1),
      );
      const retryAfterMs =
        error instanceof RateLimitError && Number.isFinite(error.retryAfter)
          ? Math.max(0, error.retryAfter! * 1_000)
          : 0;
      this.backoffUntilMs = Date.now() + Math.max(backoffMs, retryAfterMs);
      console.warn(
        `Could not refresh stale order books; backing off ${Math.max(backoffMs, retryAfterMs)}ms`,
        error,
      );
    } finally {
      for (const token of batch) {
        for (const watcher of token.watchers)
          watcher.onBookRefreshFinished(token.tokenId, requestId);

        const current = this.states.get(token.tokenId);
        if (current) this.reschedule(token.tokenId, current);
      }

      this.inFlight = false;
      this.schedulePump();
    }
  }

  private collectDue(nowMs: number): BatchToken[] {
    const batch: BatchToken[] = [];

    while (true) {
      const next = this.heap.peek();
      if (!next || next.deadlineMs > nowMs) break;

      this.heap.pop();
      // Unwatching removes a token from the heap and the state map together.
      const state = this.states.get(next.tokenId)!;
      batch.push({
        tokenId: next.tokenId,
        watchers: [...state.watchers.keys()],
        state,
      });
    }

    return batch;
  }

  private nextRequestAllowedAtMs(nowMs: number): number {
    const cutoffMs = nowMs - BOOKS_REQUEST_WINDOW_MS;
    while (
      this.requestTimesMs.length > 0 &&
      this.requestTimesMs[0]! <= cutoffMs
    )
      this.requestTimesMs.shift();

    const spacingAllowedAtMs = this.lastRequestAtMs + BOOKS_REQUEST_SPACING_MS;
    const windowAllowedAtMs =
      this.requestTimesMs.length < BOOKS_REQUEST_LIMIT
        ? nowMs
        : this.requestTimesMs[0]! + BOOKS_REQUEST_WINDOW_MS + 1;

    return Math.max(nowMs, spacingAllowedAtMs, windowAllowedAtMs);
  }

  private recordRequest(nowMs: number): void {
    this.lastRequestAtMs = nowMs;
    this.requestTimesMs.push(nowMs);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

class IndexedDeadlineHeap {
  private readonly nodes: RefreshHeapNode[] = [];
  private readonly indexByToken = new Map<TokenId, number>();

  peek(): RefreshHeapNode | undefined {
    return this.nodes[0];
  }

  set(tokenId: TokenId, deadlineMs: number): void {
    const existingIndex = this.indexByToken.get(tokenId);
    if (existingIndex === undefined) {
      const index = this.nodes.length;
      this.nodes.push({ tokenId, deadlineMs });
      this.indexByToken.set(tokenId, index);
      this.bubbleUp(index);
      return;
    }

    const previousDeadlineMs = this.nodes[existingIndex]!.deadlineMs;
    this.nodes[existingIndex] = { tokenId, deadlineMs };
    if (deadlineMs < previousDeadlineMs) this.bubbleUp(existingIndex);
    else if (deadlineMs > previousDeadlineMs) this.bubbleDown(existingIndex);
  }

  delete(tokenId: TokenId): void {
    const index = this.indexByToken.get(tokenId);
    if (index === undefined) return;

    const lastIndex = this.nodes.length - 1;
    const tail = this.nodes[lastIndex]!;
    this.nodes.pop();
    this.indexByToken.delete(tokenId);

    if (index === lastIndex) return;

    this.nodes[index] = tail;
    this.indexByToken.set(tail.tokenId, index);
    const parent = Math.floor((index - 1) / 2);
    if (
      index > 0 &&
      this.nodes[index]!.deadlineMs < this.nodes[parent]!.deadlineMs
    )
      this.bubbleUp(index);
    else this.bubbleDown(index);
  }

  pop(): RefreshHeapNode | undefined {
    const root = this.nodes[0];
    if (!root) return undefined;
    this.delete(root.tokenId);
    return root;
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.nodes[parent]!.deadlineMs <= this.nodes[index]!.deadlineMs)
        break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.nodes.length) return;

      const right = left + 1;
      const child =
        right < this.nodes.length &&
        this.nodes[right]!.deadlineMs < this.nodes[left]!.deadlineMs
          ? right
          : left;
      if (this.nodes[index]!.deadlineMs <= this.nodes[child]!.deadlineMs)
        return;

      this.swap(index, child);
      index = child;
    }
  }

  private swap(left: number, right: number): void {
    const a = this.nodes[left]!;
    const b = this.nodes[right]!;
    this.nodes[left] = b;
    this.nodes[right] = a;
    this.indexByToken.set(a.tokenId, right);
    this.indexByToken.set(b.tokenId, left);
  }
}
