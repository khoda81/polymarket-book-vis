import {
  RateLimitError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";

const BOOKS_REQUEST_LIMIT = 500;
const BOOKS_REQUEST_WINDOW_MS = 10_000;
const BOOKS_REQUEST_SPACING_MS = BOOKS_REQUEST_WINDOW_MS / BOOKS_REQUEST_LIMIT;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Temporary watchdog for Polymarket's silently-stalled market websocket.
// Keep this independent of ghost rendering precision: REST is evidence/liveness,
// not a display refresh mechanism. See #13.
export const STALE_BOOK_VERIFY_MS = 5_000;
const INITIAL_FAILURE_BACKOFF_MS = 1_000;
const MAX_FAILURE_BACKOFF_MS = 30_000;

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
  readonly onBookRefreshFinished: (tokenId: TokenId, requestId: number) => void;
}

interface TokenRefreshState {
  readonly tokenId: TokenId;
  readonly watchers: Map<BookRefreshSubscriber, number>;
}

interface RefreshHeapNode {
  readonly tokenKey: TokenId;
  readonly deadlineMs: number;
}

interface BatchToken {
  readonly tokenKey: TokenId;
  readonly tokenId: TokenId;
  readonly watchers: readonly BookRefreshSubscriber[];
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

    const tokenKey = tokenId;
    let state = this.states.get(tokenKey);
    if (!state) {
      state = {
        tokenId,
        watchers: new Map(),
      };
      this.states.set(tokenKey, state);
    }

    const previous = state.watchers.get(subscriber);
    if (previous === undefined || validThroughMs > previous)
      state.watchers.set(subscriber, validThroughMs);

    let owned = this.tokensBySubscriber.get(subscriber);
    if (!owned) {
      owned = new Set();
      this.tokensBySubscriber.set(subscriber, owned);
    }
    owned.add(tokenKey);

    this.reschedule(state);
    this.schedulePump();
  }

  unwatch(subscriber: BookRefreshSubscriber, tokenId: TokenId): void {
    this.unwatchKey(subscriber, tokenId);
    this.schedulePump();
  }

  unwatchAll(subscriber: BookRefreshSubscriber): void {
    const tokenKeys = this.tokensBySubscriber.get(subscriber);
    if (!tokenKeys) return;

    for (const tokenKey of [...tokenKeys])
      this.unwatchKey(subscriber, tokenKey);
    this.tokensBySubscriber.delete(subscriber);
    this.schedulePump();
  }

  private unwatchKey(
    subscriber: BookRefreshSubscriber,
    tokenKey: TokenId,
  ): void {
    const state = this.states.get(tokenKey);
    if (!state) return;

    state.watchers.delete(subscriber);
    this.tokensBySubscriber.get(subscriber)?.delete(tokenKey);

    if (state.watchers.size === 0) {
      this.states.delete(tokenKey);
      this.heap.delete(tokenKey);
    } else {
      this.reschedule(state);
    }
  }

  private reschedule(state: TokenRefreshState): void {
    if (state.watchers.size === 0) return;

    let oldestObservationMs = Number.POSITIVE_INFINITY;
    for (const observedThroughMs of state.watchers.values())
      oldestObservationMs = Math.min(oldestObservationMs, observedThroughMs);

    this.heap.set(state.tokenId, oldestObservationMs + STALE_BOOK_VERIFY_MS);
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
        const snapshot = snapshotByToken.get(token.tokenKey);
        if (!snapshot) continue;

        const current = this.states.get(token.tokenKey);
        for (const watcher of token.watchers) {
          if (!current?.watchers.has(watcher)) continue;
          watcher.onBookRefreshSnapshot(
            token.tokenId,
            requestId,
            requestedAtMs,
            snapshot,
          );
        }
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

        const current = this.states.get(token.tokenKey);
        if (current) this.reschedule(current);
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
      const state = this.states.get(next.tokenKey);
      if (!state) continue;

      batch.push({
        tokenKey: next.tokenKey,
        tokenId: state.tokenId,
        watchers: [...state.watchers.keys()],
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

  clear(): void {
    this.nodes.length = 0;
    this.indexByToken.clear();
  }

  peek(): RefreshHeapNode | undefined {
    return this.nodes[0];
  }

  set(tokenKey: TokenId, deadlineMs: number): void {
    const existingIndex = this.indexByToken.get(tokenKey);
    if (existingIndex === undefined) {
      const index = this.nodes.length;
      this.nodes.push({ tokenKey, deadlineMs });
      this.indexByToken.set(tokenKey, index);
      this.bubbleUp(index);
      return;
    }

    const previousDeadlineMs = this.nodes[existingIndex]!.deadlineMs;
    this.nodes[existingIndex] = { tokenKey, deadlineMs };
    if (deadlineMs < previousDeadlineMs) this.bubbleUp(existingIndex);
    else if (deadlineMs > previousDeadlineMs) this.bubbleDown(existingIndex);
  }

  delete(tokenKey: TokenId): boolean {
    const index = this.indexByToken.get(tokenKey);
    if (index === undefined) return false;

    const lastIndex = this.nodes.length - 1;
    const tail = this.nodes[lastIndex]!;
    this.nodes.pop();
    this.indexByToken.delete(tokenKey);

    if (index === lastIndex) return true;

    this.nodes[index] = tail;
    this.indexByToken.set(tail.tokenKey, index);
    const parent = Math.floor((index - 1) / 2);
    if (
      index > 0 &&
      this.nodes[index]!.deadlineMs < this.nodes[parent]!.deadlineMs
    )
      this.bubbleUp(index);
    else this.bubbleDown(index);
    return true;
  }

  pop(): RefreshHeapNode | undefined {
    const root = this.nodes[0];
    if (!root) return undefined;
    this.delete(root.tokenKey);
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
    this.indexByToken.set(a.tokenKey, right);
    this.indexByToken.set(b.tokenKey, left);
  }
}
