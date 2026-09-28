import type { ConnectionStatus } from "@/lib/chartState";
import {
  applyPriceChange,
  bookFromSnapshot,
  type CanonicalBookChange,
  type RawPriceChange,
} from "@/lib/bookIngestion";
import type { MarketResolutionUpdate } from "@/lib/marketLifecycle";
import type { TokenBook } from "@/lib/orderBook";
import {
  bookRefreshCoordinator,
  type BookRefreshSnapshot,
  type BookRefreshSubscriber,
} from "./bookRefreshCoordinator";
import {
  TransportError,
  type ClobAssetId,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";

const SUBSCRIPTION_RETRY_MS = 1_000;
const DEBUG_REPORT_INTERVAL_MS = 5_000;

export type LiveBookUpdate =
  | {
      readonly kind: "snapshot";
      readonly validThroughMs: number;
    }
  | {
      readonly kind: "levels";
      readonly validThroughMs: number;
      readonly changes: readonly {
        readonly side: "bid" | "ask";
        readonly price: import("@/lib/price").Price;
        readonly shares: number;
      }[];
    };

export interface LiveBookFeedCallbacks {
  readonly onConnectionStatus: (status: ConnectionStatus) => void;
  readonly onBookUpdated: (
    tokenId: TokenId,
    book: TokenBook,
    update: LiveBookUpdate,
  ) => void;
  readonly onMarketResolved: (resolution: MarketResolutionUpdate) => void;
}

export interface LiveBookWatch {
  readonly ready: Promise<void>;
  close(): void;
}

interface RefreshScheduler {
  observe(
    subscriber: BookRefreshSubscriber,
    tokenId: TokenId,
    validThroughMs: number,
  ): void;
  unwatch(subscriber: BookRefreshSubscriber, tokenId: TokenId): void;
  unwatchAll(subscriber: BookRefreshSubscriber): void;
}

export interface LiveBookCoordinatorOptions {
  readonly refreshScheduler?: RefreshScheduler;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
  readonly debug?: boolean;
  readonly handoffYield?: () => Promise<void>;
}

interface Deferred {
  readonly promise: Promise<void>;
  settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
}

interface WatchState {
  readonly callbacks: LiveBookFeedCallbacks;
  readonly tokenIds: Map<ClobAssetId, TokenId>;
  readonly ready: Deferred;
  status: "connecting" | "live" | "failed" | "closed";
}

interface TokenState {
  readonly tokenId: TokenId;
  readonly watchers: Set<WatchState>;
  book?: TokenBook;
  validThroughMs?: number;
  subscriptionRequestedAtMs?: number;
}

interface BufferedBookDelta {
  readonly timestampMs: number;
  readonly changes: readonly RawPriceChange[];
}

interface BookRefreshContext {
  readonly requestId: number;
  readonly requestedAtMs: number;
  readonly buffered: BufferedBookDelta[];
  superseded: boolean;
}

interface ActiveSubscription {
  readonly stream: SubscriptionHandle<MarketEvent>;
  readonly tokenKeys: ReadonlySet<ClobAssetId>;
  retired: boolean;
  closed: boolean;
}

interface TokenChanges {
  readonly raw: RawPriceChange[];
  readonly canonical: CanonicalBookChange[];
}

interface DebugStats {
  startedAtMs: number;
  activeHandles: number;
  receivedEvents: number;
  routedTokenBatches: number;
  downstreamDeliveries: number;
  handoffDuplicates: number;
  maxRouteMs: number;
}

const coordinators = new WeakMap<PublicClient, LiveBookCoordinator>();

export function liveBookCoordinator(client: PublicClient): LiveBookCoordinator {
  let coordinator = coordinators.get(client);
  if (!coordinator) {
    coordinator = new LiveBookCoordinator(client);
    coordinators.set(client, coordinator);
  }
  return coordinator;
}

/**
 * One canonical live-book store and one logical market subscription per client.
 * Views retain independent pressure histories but share transport, ingestion,
 * REST reconciliation, and current order books.
 */
export class LiveBookCoordinator {
  private readonly tokens = new Map<ClobAssetId, TokenState>();
  private readonly watches = new Set<WatchState>();
  private readonly refreshContexts = new Map<ClobAssetId, BookRefreshContext>();
  private readonly seenEvents = new WeakSet<object>();
  private readonly refreshScheduler: RefreshScheduler;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly debug: boolean;
  private readonly handoffYield: () => Promise<void>;
  private readonly debugStats: DebugStats = {
    startedAtMs: 0,
    activeHandles: 0,
    receivedEvents: 0,
    routedTokenBatches: 0,
    downstreamDeliveries: 0,
    handoffDuplicates: 0,
    maxRouteMs: 0,
  };
  private readonly refreshSubscriber: BookRefreshSubscriber = {
    onBookRefreshStarted: (tokenId, requestId, requestedAtMs) =>
      this.beginBookRefresh(tokenId, requestId, requestedAtMs),
    onBookRefreshSnapshot: (tokenId, requestId, requestedAtMs, snapshot) =>
      this.applyBookRefresh(tokenId, requestId, requestedAtMs, snapshot),
    onBookRefreshFinished: (tokenId, requestId) =>
      this.finishBookRefresh(tokenId, requestId),
  };

  private active: ActiveSubscription | null = null;
  private desiredRevision = 0;
  private reconcileScheduled = false;
  private reconciling = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly client: PublicClient,
    options: LiveBookCoordinatorOptions = {},
  ) {
    this.refreshScheduler =
      options.refreshScheduler ?? bookRefreshCoordinator(client);
    this.retryDelayMs = options.retryDelayMs ?? SUBSCRIPTION_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.handoffYield = options.handoffYield ?? yieldToNextTask;
    this.debug =
      options.debug ??
      (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("pressureDebug") ===
          "1");
  }

  watch(
    tokenIds: readonly TokenId[],
    callbacks: LiveBookFeedCallbacks,
  ): LiveBookWatch {
    const unique = new Map<ClobAssetId, TokenId>();
    for (const tokenId of tokenIds) unique.set(tokenId, tokenId);

    const state: WatchState = {
      callbacks,
      tokenIds: unique,
      ready: createDeferred(),
      status: "connecting",
    };
    this.watches.add(state);
    this.notifyConnectionStatus(state, "connecting");

    for (const [tokenKey, tokenId] of unique) {
      let token = this.tokens.get(tokenKey);
      if (!token) {
        token = { tokenId, watchers: new Set() };
        this.tokens.set(tokenKey, token);
      }
      token.watchers.add(state);
    }

    if (unique.size === 0) {
      state.status = "live";
      this.notifyConnectionStatus(state, "live");
      state.ready.resolve();
    } else {
      this.requestReconcile();
    }

    return {
      ready: state.ready.promise,
      close: () => this.closeWatch(state),
    };
  }

  getBook(tokenId: TokenId): TokenBook | undefined {
    return this.tokens.get(tokenId)?.book;
  }

  private closeWatch(watch: WatchState): void {
    if (watch.status === "closed" || watch.status === "failed") return;

    watch.status = "closed";
    watch.ready.resolve();
    this.watches.delete(watch);
    this.detachWatch(watch);
    this.requestReconcile();
  }

  private detachWatch(watch: WatchState): void {
    for (const tokenKey of watch.tokenIds.keys()) {
      const token = this.tokens.get(tokenKey);
      if (!token) continue;

      token.watchers.delete(watch);
    }
    watch.tokenIds.clear();
  }

  private dropToken(tokenKey: ClobAssetId, token: TokenState): void {
    this.tokens.delete(tokenKey);
    this.refreshContexts.delete(tokenKey);
    this.refreshScheduler.unwatch(this.refreshSubscriber, token.tokenId);
  }

  private requestReconcile(): void {
    this.desiredRevision++;
    if (this.retryTimer !== undefined) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.reconcileScheduled || this.reconciling) return;

    this.reconcileScheduled = true;
    queueMicrotask(() => {
      this.reconcileScheduled = false;
      void this.reconcile();
    });
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;

    try {
      while (true) {
        const revision = this.desiredRevision;
        const desired = this.desiredTokens();
        const desiredKeys = new Set(desired.map(([key]) => key));

        if (sameKeys(this.active?.tokenKeys, desiredKeys)) {
          this.markCoveredWatchesLive();
          this.pruneUnwatchedTokens();
          if (revision === this.desiredRevision) return;
          continue;
        }

        if (desired.length === 0) {
          const previous = this.active;
          this.active = null;
          if (previous) {
            previous.retired = true;
            await this.closeSubscription(previous);
          }
          this.pruneUnwatchedTokens();
          if (revision === this.desiredRevision) return;
          continue;
        }

        const requestedAtMs = this.now();
        let stream: SubscriptionHandle<MarketEvent>;
        try {
          stream = await this.client.subscribe([
            {
              topic: "market",
              assetIds: desired.map(([, tokenId]) => tokenId),
              customFeatureEnabled: true,
            },
          ]);
        } catch (error) {
          if (revision !== this.desiredRevision) continue;
          if (error instanceof TransportError) {
            this.scheduleRetry();
            return;
          }
          this.failUncoveredWatches(error);
          continue;
        }

        this.debugStats.activeHandles++;
        const next: ActiveSubscription = {
          stream,
          tokenKeys: desiredKeys,
          retired: false,
          closed: false,
        };

        if (revision !== this.desiredRevision) {
          next.retired = true;
          await this.closeSubscription(next);
          continue;
        }

        const previous = this.active;
        for (const [tokenKey] of desired) {
          if (previous?.tokenKeys.has(tokenKey)) continue;
          const token = this.tokens.get(tokenKey);
          if (token) token.subscriptionRequestedAtMs = requestedAtMs;
        }

        if (previous) {
          // The replacement queue starts collecting as soon as subscribe()
          // registers it. Give the old reader a task boundary to drain events
          // that predate that registration before changing queue ownership.
          await this.handoffYield();
          if (revision !== this.desiredRevision) {
            next.retired = true;
            await this.closeSubscription(next);
            continue;
          }
          previous.retired = true;
        }

        this.active = next;
        void this.readEvents(next);
        this.markCoveredWatchesLive();
        if (previous) await this.closeSubscription(previous);
        this.pruneUnwatchedTokens();
        if (revision === this.desiredRevision) return;
      }
    } finally {
      this.reconciling = false;
      if (
        this.retryTimer === undefined &&
        !sameKeys(this.active?.tokenKeys, this.desiredTokenKeys())
      )
        this.requestReconcile();
    }
  }

  private desiredTokens(): [ClobAssetId, TokenId][] {
    return [...this.tokens.entries()]
      .filter(([, token]) => token.watchers.size > 0)
      .map(([key, token]) => [key, token.tokenId] as [ClobAssetId, TokenId])
      .sort(([left], [right]) => left.localeCompare(right));
  }

  private desiredTokenKeys(): ReadonlySet<ClobAssetId> {
    return new Set(this.desiredTokens().map(([key]) => key));
  }

  private pruneUnwatchedTokens(): void {
    for (const [tokenKey, token] of this.tokens)
      if (token.watchers.size === 0) this.dropToken(tokenKey, token);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = globalThis.setTimeout(() => {
      this.retryTimer = undefined;
      this.requestReconcile();
    }, this.retryDelayMs);
  }

  private failUncoveredWatches(error: unknown): void {
    const activeKeys = this.active?.tokenKeys;
    const failed = [...this.watches].filter(
      (watch) =>
        watch.status === "connecting" && !isWatchCovered(watch, activeKeys),
    );

    for (const watch of failed) {
      watch.status = "failed";
      this.notifyConnectionStatus(watch, "disconnected");
      watch.ready.reject(error);
      this.watches.delete(watch);
      this.detachWatch(watch);
    }
    this.desiredRevision++;
  }

  private markCoveredWatchesLive(): void {
    const activeKeys = this.active?.tokenKeys;
    for (const watch of this.watches) {
      if (watch.status !== "connecting" || !isWatchCovered(watch, activeKeys))
        continue;

      watch.status = "live";
      this.notifyConnectionStatus(watch, "live");
      for (const tokenKey of watch.tokenIds.keys()) {
        const token = this.tokens.get(tokenKey);
        if (!token?.book || token.validThroughMs === undefined) continue;
        this.notifyBookUpdated(watch, token, {
          kind: "snapshot",
          validThroughMs: token.validThroughMs,
        });
      }
      watch.ready.resolve();
    }
  }

  private async readEvents(subscription: ActiveSubscription): Promise<void> {
    try {
      for await (const event of subscription.stream) {
        if (subscription.retired || this.active !== subscription) return;
        this.routeEvent(event);
      }
    } catch (error) {
      if (!subscription.retired && this.active === subscription)
        console.error("Market websocket stream ended with error", error);
    } finally {
      if (!subscription.retired && this.active === subscription)
        this.handleTerminalSubscription(subscription);
    }
  }

  private handleTerminalSubscription(subscription: ActiveSubscription): void {
    subscription.retired = true;
    this.active = null;
    void this.closeSubscription(subscription);

    this.refreshContexts.clear();
    this.refreshScheduler.unwatchAll(this.refreshSubscriber);
    for (const token of this.tokens.values()) {
      token.book = undefined;
      token.validThroughMs = undefined;
      token.subscriptionRequestedAtMs = undefined;
    }

    for (const watch of this.watches) {
      if (watch.status !== "live") continue;
      this.notifyConnectionStatus(watch, "disconnected");
      watch.status = "connecting";
      this.notifyConnectionStatus(watch, "connecting");
    }
    this.requestReconcile();
  }

  private async closeSubscription(
    subscription: ActiveSubscription,
  ): Promise<void> {
    if (subscription.closed) return;
    subscription.closed = true;
    try {
      await subscription.stream.close();
    } catch (error) {
      console.warn("Could not close replaced market subscription", error);
    } finally {
      this.debugStats.activeHandles = Math.max(
        0,
        this.debugStats.activeHandles - 1,
      );
    }
  }

  private routeEvent(event: MarketEvent): void {
    const object = event as object;
    if (this.seenEvents.has(object)) {
      this.debugStats.handoffDuplicates++;
      return;
    }
    this.seenEvents.add(object);

    const startedAtMs = debugNow();
    this.debugStats.receivedEvents++;
    if (event.type === "book") this.routeBook(event);
    else if (event.type === "price_change") this.routePriceChanges(event);
    else if (event.type === "market_resolved") this.routeResolution(event);

    this.debugStats.maxRouteMs = Math.max(
      this.debugStats.maxRouteMs,
      debugNow() - startedAtMs,
    );
    this.maybeReportDebugStats();
  }

  private routeBook(event: Extract<MarketEvent, { type: "book" }>): void {
    const tokenKey = event.payload.assetId;
    const token = this.tokens.get(tokenKey);
    if (!token) return;

    const refresh = this.refreshContexts.get(tokenKey);
    if (refresh) refresh.superseded = true;

    token.book = bookFromSnapshot(event.payload.bids, event.payload.asks);
    token.validThroughMs = snapshotValidThroughMs(
      event.payload.timestamp,
      token.subscriptionRequestedAtMs ?? this.now(),
      this.now(),
    );
    this.debugStats.routedTokenBatches++;
    this.notifyToken(token, {
      kind: "snapshot",
      validThroughMs: token.validThroughMs,
    });
    this.observeBook(token, token.validThroughMs);
  }

  private routePriceChanges(
    event: Extract<MarketEvent, { type: "price_change" }>,
  ): void {
    const validThroughMs = eventTimeMs(
      event.payload.timestamp,
      this.now(),
      this.now(),
    );
    const changesByToken = new Map<TokenState, TokenChanges>();

    for (const change of event.payload.priceChanges) {
      const token = this.tokens.get(change.assetId);
      if (!token?.book) continue;

      let changes = changesByToken.get(token);
      if (!changes) {
        changes = { raw: [], canonical: [] };
        changesByToken.set(token, changes);
      }
      const raw: RawPriceChange = {
        side: change.side,
        price: change.price,
        size: change.size,
      };
      changes.raw.push(raw);
      changes.canonical.push(applyPriceChange(token.book, raw));
    }

    for (const [token, changes] of changesByToken) {
      const tokenKey = token.tokenId;
      const refresh = this.refreshContexts.get(tokenKey);
      if (refresh && !refresh.superseded)
        refresh.buffered.push({
          timestampMs: validThroughMs,
          changes: changes.raw,
        });

      token.validThroughMs = Math.max(
        token.validThroughMs ?? 0,
        validThroughMs,
      );
      this.debugStats.routedTokenBatches++;
      this.notifyToken(token, {
        kind: "levels",
        validThroughMs,
        changes: changes.canonical,
      });
      this.observeBook(token, validThroughMs);
    }
  }

  private routeResolution(
    event: Extract<MarketEvent, { type: "market_resolved" }>,
  ): void {
    const assetIds = event.payload.assetIds ?? [];
    const affected = new Set<WatchState>();

    for (const assetId of assetIds) {
      const tokenKey = assetId;
      const token = this.tokens.get(tokenKey);
      if (!token) continue;

      for (const watch of token.watchers) {
        if (watch.status === "live") affected.add(watch);
        watch.tokenIds.delete(tokenKey);
      }
      token.watchers.clear();
      this.dropToken(tokenKey, token);
    }

    const resolution: MarketResolutionUpdate = {
      conditionId: event.payload.conditionId,
      assetIds,
      winningAssetId: event.payload.winningAssetId ?? null,
      winningOutcome: event.payload.winningOutcome ?? null,
    };
    for (const watch of affected) {
      this.debugStats.downstreamDeliveries++;
      this.callSafely(() => watch.callbacks.onMarketResolved(resolution));
    }
    if (affected.size > 0) this.requestReconcile();
  }

  private observeBook(token: TokenState, validThroughMs: number): void {
    this.refreshScheduler.observe(
      this.refreshSubscriber,
      token.tokenId,
      validThroughMs,
    );
  }

  private beginBookRefresh(
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
  ): void {
    const tokenKey = tokenId;
    const token = this.tokens.get(tokenKey);
    if (!token?.book || token.watchers.size === 0) return;

    this.refreshContexts.set(tokenKey, {
      requestId,
      requestedAtMs,
      buffered: [],
      superseded: false,
    });
  }

  private applyBookRefresh(
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
    snapshot: BookRefreshSnapshot,
  ): void {
    const tokenKey = tokenId;
    const context = this.refreshContexts.get(tokenKey);
    const token = this.tokens.get(tokenKey);
    if (
      !context ||
      !token ||
      token.watchers.size === 0 ||
      context.requestId !== requestId ||
      context.requestedAtMs !== requestedAtMs ||
      context.superseded ||
      snapshot.assetId !== tokenKey
    )
      return;

    const snapshotTimestampMs = eventTimeMs(
      snapshot.timestamp,
      requestedAtMs,
      this.now(),
    );
    const book = bookFromSnapshot(snapshot.bids, snapshot.asks);
    let validThroughMs = Math.max(requestedAtMs, snapshotTimestampMs);

    for (const delta of context.buffered) {
      if (delta.timestampMs <= snapshotTimestampMs) continue;
      for (const change of delta.changes) applyPriceChange(book, change);
      validThroughMs = Math.max(validThroughMs, delta.timestampMs);
    }

    token.book = book;
    token.validThroughMs = validThroughMs;
    this.notifyToken(token, { kind: "snapshot", validThroughMs });
    this.observeBook(token, validThroughMs);
  }

  private finishBookRefresh(tokenId: TokenId, requestId: number): void {
    const tokenKey = tokenId;
    if (this.refreshContexts.get(tokenKey)?.requestId === requestId)
      this.refreshContexts.delete(tokenKey);
  }

  private notifyToken(token: TokenState, update: LiveBookUpdate): void {
    if (!token.book) return;
    for (const watch of [...token.watchers]) {
      if (watch.status !== "live") continue;
      this.notifyBookUpdated(watch, token, update);
    }
  }

  private notifyBookUpdated(
    watch: WatchState,
    token: TokenState,
    update: LiveBookUpdate,
  ): void {
    if (!token.book) return;
    this.debugStats.downstreamDeliveries++;
    this.callSafely(() =>
      watch.callbacks.onBookUpdated(token.tokenId, token.book!, update),
    );
  }

  private notifyConnectionStatus(
    watch: WatchState,
    status: ConnectionStatus,
  ): void {
    this.callSafely(() => watch.callbacks.onConnectionStatus(status));
  }

  private callSafely(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error("Live-book subscriber callback failed", error);
    }
  }

  private maybeReportDebugStats(): void {
    if (!this.debug) return;

    const nowMs = debugNow();
    if (this.debugStats.startedAtMs === 0) this.debugStats.startedAtMs = nowMs;
    const elapsedMs = nowMs - this.debugStats.startedAtMs;
    if (elapsedMs < DEBUG_REPORT_INTERVAL_MS) return;

    console.debug(
      `[live-books] ${JSON.stringify({
        seconds: elapsedMs / 1_000,
        activeHandles: this.debugStats.activeHandles,
        watchedTokens: this.tokens.size,
        subscribers: this.watches.size,
        eventsPerSecond: (this.debugStats.receivedEvents * 1_000) / elapsedMs,
        routedTokenBatchesPerSecond:
          (this.debugStats.routedTokenBatches * 1_000) / elapsedMs,
        downstreamDeliveriesPerSecond:
          (this.debugStats.downstreamDeliveries * 1_000) / elapsedMs,
        handoffDuplicates: this.debugStats.handoffDuplicates,
        maxRouteMs: this.debugStats.maxRouteMs,
      })}`,
    );
    this.debugStats.startedAtMs = nowMs;
    this.debugStats.receivedEvents = 0;
    this.debugStats.routedTokenBatches = 0;
    this.debugStats.downstreamDeliveries = 0;
    this.debugStats.handoffDuplicates = 0;
    this.debugStats.maxRouteMs = 0;
  }
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred = {
    promise: new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve() {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise();
    },
    reject(error) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
}

function isWatchCovered(
  watch: WatchState,
  tokenKeys: ReadonlySet<ClobAssetId> | undefined,
): boolean {
  if (!tokenKeys) return watch.tokenIds.size === 0;
  for (const tokenKey of watch.tokenIds.keys())
    if (!tokenKeys.has(tokenKey)) return false;
  return true;
}

function sameKeys(
  left: ReadonlySet<ClobAssetId> | undefined,
  right: ReadonlySet<ClobAssetId>,
): boolean {
  if (!left) return right.size === 0;
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

function snapshotValidThroughMs(
  value: unknown,
  snapshotRequestedAtMs: number,
  nowMs: number,
): number {
  return Math.max(
    snapshotRequestedAtMs,
    eventTimeMs(value, snapshotRequestedAtMs, nowMs),
  );
}

function eventTimeMs(
  value: unknown,
  fallbackMs: number,
  nowMs: number,
): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    timestamp <= nowMs + 60_000
    ? timestamp
    : fallbackMs;
}

function debugNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function yieldToNextTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
