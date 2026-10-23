import {
  applyPriceChange,
  bookFromSnapshot,
  type CanonicalBookChange,
} from "@/domain/books/bookIngestion";
import { PRESSURE_DEBUG } from "@/shared/debug";
import type { TokenBook } from "@/domain/books/orderBook";
import { LiveTokenState } from "./liveTokenState";
import {
  booksEqual,
  marketEventKey,
  marketEventPayload,
  marketEventTimeMs,
  sameTokenKeys,
} from "./liveBookProtocol";
import type {
  LiveBookFeedCallbacks,
  LiveBookUpdate,
  LiveBookWatch,
} from "./liveBookContracts";
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
  /**
   * Optional stale-book verifier. Production uses the shared REST watchdog;
   * pass null to disable it in a test or diagnostic build.
   */
  readonly refreshScheduler?: RefreshScheduler | null;
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
  readonly stream: LiveTokenState;
}

interface BookRefreshContext {
  readonly requestId: number;
  readonly requestedAtMs: number;
  superseded: boolean;
}

interface ActiveSubscription {
  readonly stream: SubscriptionHandle<MarketEvent>;
  readonly tokenKeys: ReadonlySet<ClobAssetId>;
  readonly marketWatermarks: Map<string, number>;
  retired: boolean;
  closed: boolean;
}

interface TokenChanges {
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
 * market-local causal watermarking and current books.
 */
export class LiveBookCoordinator {
  private readonly tokens = new Map<ClobAssetId, TokenState>();
  private readonly watches = new Set<WatchState>();
  private readonly refreshContexts = new Map<ClobAssetId, BookRefreshContext>();
  private readonly seenEvents = new WeakSet<object>();
  private readonly refreshScheduler: RefreshScheduler | null;
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
    onBookRefreshUnavailable: (tokenId, requestId, requestedAtMs) => {
      const context = this.refreshContexts.get(tokenId);
      if (
        context?.requestId === requestId &&
        context.requestedAtMs === requestedAtMs &&
        !context.superseded
      )
        this.requestMetadataRecovery([tokenId]);
    },
    onBookRefreshFinished: (tokenId, requestId) =>
      this.finishBookRefresh(tokenId, requestId),
  };

  private active: ActiveSubscription | null = null;
  private desiredRevision = 0;
  private reconcileScheduled = false;
  private reconciling = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly recoverySubscribers = new Set<
    (tokenIds: readonly TokenId[]) => void
  >();

  constructor(
    private readonly client: PublicClient,
    options: LiveBookCoordinatorOptions = {},
  ) {
    this.refreshScheduler =
      options.refreshScheduler === undefined
        ? bookRefreshCoordinator(client)
        : options.refreshScheduler;
    this.retryDelayMs = options.retryDelayMs ?? SUBSCRIPTION_RETRY_MS;
    this.now = options.now ?? Date.now;
    this.handoffYield = options.handoffYield ?? yieldToNextTask;
    this.debug = options.debug ?? PRESSURE_DEBUG;
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

    for (const [tokenKey, tokenId] of unique) {
      let token = this.tokens.get(tokenKey);
      if (!token) {
        token = { tokenId, watchers: new Set(), stream: new LiveTokenState() };
        this.tokens.set(tokenKey, token);
      }
      token.watchers.add(state);
    }

    if (unique.size === 0) {
      state.status = "live";
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
    return this.tokens.get(tokenId)?.stream.book;
  }

  subscribeRecovery(
    subscriber: (tokenIds: readonly TokenId[]) => void,
  ): () => void {
    this.recoverySubscribers.add(subscriber);
    return () => this.recoverySubscribers.delete(subscriber);
  }

  /** A wake/reconnect needs a new snapshot barrier, not replay into old books. */
  recover(): void {
    if (this.active) this.handleTerminalSubscription(this.active);
    else if (this.watches.size > 0) this.requestReconcile();
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
    this.refreshScheduler?.unwatch(this.refreshSubscriber, token.tokenId);
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

        if (sameTokenKeys(this.active?.tokenKeys, desiredKeys)) {
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
          marketWatermarks: new Map(),
          retired: false,
          closed: false,
        };

        if (revision !== this.desiredRevision) {
          next.retired = true;
          await this.closeSubscription(next);
          continue;
        }

        const previous = this.active;

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

        // A replacement subscription is a new causal stream. Every token must
        // bootstrap from a fresh book snapshot; no state crosses this barrier.
        const reconnecting = desired.some(
          ([tokenKey]) => this.tokens.get(tokenKey)?.stream.book !== undefined,
        );
        this.refreshContexts.clear();
        for (const [tokenKey] of desired) {
          const token = this.tokens.get(tokenKey);
          if (!token) continue;
          token.stream.beginStream(requestedAtMs);
        }

        this.active = next;
        void this.readEvents(next);
        this.markCoveredWatchesLive();
        if (reconnecting)
          this.requestMetadataRecovery(desired.map(([, tokenId]) => tokenId));
        if (previous) await this.closeSubscription(previous);
        this.pruneUnwatchedTokens();
        if (revision === this.desiredRevision) return;
      }
    } finally {
      this.reconciling = false;
      if (
        this.retryTimer === undefined &&
        !sameTokenKeys(this.active?.tokenKeys, this.desiredTokenKeys())
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
      for (const tokenKey of watch.tokenIds.keys()) {
        const token = this.tokens.get(tokenKey);
        const observed = token?.stream.observed;
        if (!observed) continue;
        this.notifyBookUpdated(watch, token, {
          kind: "snapshot",
          validThroughMs: observed.validThroughMs,
        });
      }
      watch.ready.resolve();
    }
  }

  private async readEvents(subscription: ActiveSubscription): Promise<void> {
    try {
      for await (const event of subscription.stream) {
        if (subscription.retired || this.active !== subscription) return;
        this.routeEvent(subscription, event);
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
    this.refreshScheduler?.unwatchAll(this.refreshSubscriber);
    for (const token of this.tokens.values()) {
      // Preserve the last book for display/cache consumers, but never mutate
      // it from the next stream until that stream establishes a fresh snapshot.
      token.stream.disconnect();
    }

    for (const watch of this.watches)
      if (watch.status === "live") watch.status = "connecting";
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
      this.debugStats.activeHandles--;
    }
  }

  private routeEvent(
    subscription: ActiveSubscription,
    event: MarketEvent,
  ): void {
    const object = event as object;
    if (this.seenEvents.has(object)) {
      this.debugStats.handoffDuplicates++;
      return;
    }
    this.seenEvents.add(object);

    const startedAtMs = debugNow();
    this.debugStats.receivedEvents++;

    if (event.type === "book") this.routeBook(subscription, event);
    else if (event.type === "price_change")
      this.routePriceChanges(subscription, event);
    else if (event.type === "market_resolved")
      this.routeResolution(subscription, event);
    else this.routeWatermark(subscription, event);

    this.debugStats.maxRouteMs = Math.max(
      this.debugStats.maxRouteMs,
      debugNow() - startedAtMs,
    );
    this.maybeReportDebugStats();
  }

  private routeBook(
    subscription: ActiveSubscription,
    event: Extract<MarketEvent, { type: "book" }>,
  ): void {
    const tokenKey = event.payload.assetId;
    const token = this.tokens.get(tokenKey);
    if (!token) return;

    const refresh = this.refreshContexts.get(tokenKey);
    if (refresh) refresh.superseded = true;

    const marketKey = marketEventKey(event);
    const timestampMs = marketEventTimeMs(event.payload.timestamp);
    const marketWatermark = this.recordMarketWatermark(
      subscription,
      marketKey,
      timestampMs,
    );
    if (marketKey) {
      token.stream.associateMarket(marketKey);
      this.advanceMarketThrough(
        subscription,
        marketKey,
        marketWatermark,
        new Set([tokenKey]),
      );
    }

    const { firstOnStream, validThroughMs } = token.stream.acceptSnapshot(
      bookFromSnapshot(event.payload.bids, event.payload.asks),
      marketWatermark,
    );
    this.debugStats.routedTokenBatches++;
    this.notifyToken(token, {
      kind: firstOnStream ? "snapshot" : "replace",
      validThroughMs,
    });
    this.observeBook(token, validThroughMs);
  }

  private routePriceChanges(
    subscription: ActiveSubscription,
    event: Extract<MarketEvent, { type: "price_change" }>,
  ): void {
    const marketKey = marketEventKey(event);
    const timestampMs = marketEventTimeMs(event.payload.timestamp);
    const marketWatermark = this.recordMarketWatermark(
      subscription,
      marketKey,
      timestampMs,
    );
    const changesByToken = new Map<TokenState, TokenChanges>();
    const changedKeys = new Set<ClobAssetId>();

    for (const change of event.payload.priceChanges) {
      const token = this.tokens.get(change.assetId);
      if (!token) continue;
      changedKeys.add(change.assetId);
      if (marketKey) token.stream.associateMarket(marketKey);

      const refresh = this.refreshContexts.get(change.assetId);
      if (refresh) refresh.superseded = true;
      const book = token.stream.streamBook();
      if (!book) continue;

      let changes = changesByToken.get(token);
      if (!changes) {
        changes = { canonical: [] };
        changesByToken.set(token, changes);
      }
      changes.canonical.push(
        applyPriceChange(book, {
          side: change.side,
          price: change.price,
          size: change.size,
        }),
      );
    }

    if (marketKey)
      this.advanceMarketThrough(
        subscription,
        marketKey,
        marketWatermark,
        changedKeys,
      );

    for (const [token, changes] of changesByToken) {
      const validThroughMs = token.stream.confirmThrough(marketWatermark);
      this.debugStats.routedTokenBatches++;
      this.notifyToken(token, {
        kind: "levels",
        validThroughMs,
        changes: changes.canonical,
      });
      this.observeBook(token, validThroughMs);
    }
  }

  private routeWatermark(
    subscription: ActiveSubscription,
    event: MarketEvent,
  ): void {
    const marketKey = marketEventKey(event);
    if (!marketKey) return;
    const timestampMs = marketEventTimeMs(marketEventPayload(event).timestamp);
    const watermark = this.recordMarketWatermark(
      subscription,
      marketKey,
      timestampMs,
    );
    this.advanceMarketThrough(subscription, marketKey, watermark, new Set());
  }

  private routeResolution(
    subscription: ActiveSubscription,
    event: Extract<MarketEvent, { type: "market_resolved" }>,
  ): void {
    const assetIds = event.payload.assetIds ?? [];
    const marketKey = marketEventKey(event);
    const resolvedAtMs = this.recordMarketWatermark(
      subscription,
      marketKey,
      marketEventTimeMs(marketEventPayload(event).timestamp),
    );
    if (marketKey)
      this.advanceMarketThrough(
        subscription,
        marketKey,
        resolvedAtMs,
        new Set(assetIds),
      );

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

    const resolution = {
      conditionId: event.payload.conditionId,
      assetIds,
      winningAssetId: event.payload.winningAssetId ?? null,
      winningOutcome: event.payload.winningOutcome ?? null,
      resolvedAtMs: resolvedAtMs ?? null,
    };
    for (const watch of affected) {
      this.debugStats.downstreamDeliveries++;
      this.callSafely(() => watch.callbacks.onMarketResolved(resolution));
    }
    if (affected.size > 0) this.requestReconcile();
  }

  private recordMarketWatermark(
    subscription: ActiveSubscription,
    marketKey: string | null,
    timestampMs: number | null,
  ): number | undefined {
    if (!marketKey) return timestampMs ?? undefined;

    const previous = subscription.marketWatermarks.get(marketKey);
    if (timestampMs === null) return previous;

    // Polymarket timestamps are causal evidence, not a strict sequence. The
    // stream delivery order is authoritative within this market, so preserve
    // the strongest lower bound we have seen rather than reconnecting on a
    // small timestamp regression.
    const watermarkMs =
      previous === undefined ? timestampMs : Math.max(previous, timestampMs);
    subscription.marketWatermarks.set(marketKey, watermarkMs);
    return watermarkMs;
  }

  private advanceMarketThrough(
    subscription: ActiveSubscription,
    marketKey: string,
    watermarkMs: number | undefined,
    excluded: ReadonlySet<ClobAssetId>,
  ): void {
    if (watermarkMs === undefined) return;

    for (const [tokenKey, token] of this.tokens) {
      if (
        excluded.has(tokenKey) ||
        !subscription.tokenKeys.has(tokenKey) ||
        token.stream.marketKey !== marketKey ||
        !token.stream.synchronized
      )
        continue;

      const validThroughMs = token.stream.advanceThrough(watermarkMs);
      if (validThroughMs === null) continue;
      this.debugStats.routedTokenBatches++;
      this.notifyToken(token, { kind: "watermark", validThroughMs });
      this.observeBook(token, validThroughMs);
    }
  }

  private observeBook(token: TokenState, validThroughMs: number): void {
    this.refreshScheduler?.observe(
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
    if (!token?.stream.synchronized || token.watchers.size === 0) return;

    this.refreshContexts.set(tokenKey, {
      requestId,
      requestedAtMs,
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
      !token.stream.synchronized ||
      token.watchers.size === 0 ||
      context.requestId !== requestId ||
      context.requestedAtMs !== requestedAtMs ||
      context.superseded ||
      snapshot.assetId !== tokenKey
    )
      return;

    const refreshed = bookFromSnapshot(snapshot.bids, snapshot.asks);
    if (token.stream.book && booksEqual(token.stream.book, refreshed)) {
      const validThroughMs = token.stream.confirmThrough(requestedAtMs);
      // REST equality is evidence that the existing canonical geometry is
      // still valid; it is not a new stream snapshot. Advance only causality.
      this.notifyToken(token, { kind: "watermark", validThroughMs });
      this.observeBook(token, validThroughMs);
      return;
    }

    // A differing REST book proves the live websocket may be stale, but
    // without a shared sequence/barrier it cannot be merged into that stream.
    // Replace the stream and let its initial book establish a new causal base.
    const active = this.active;
    if (active) this.handleTerminalSubscription(active);
  }

  private finishBookRefresh(tokenId: TokenId, requestId: number): void {
    const tokenKey = tokenId;
    if (this.refreshContexts.get(tokenKey)?.requestId === requestId)
      this.refreshContexts.delete(tokenKey);
  }

  private requestMetadataRecovery(tokenIds: readonly TokenId[]): void {
    for (const subscriber of [...this.recoverySubscribers])
      this.callSafely(() => subscriber(tokenIds));
  }

  private notifyToken(token: TokenState, update: LiveBookUpdate): void {
    if (!token.stream.book) return;
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
    const book = token.stream.book;
    if (!book) return;
    this.debugStats.downstreamDeliveries++;
    this.callSafely(() =>
      watch.callbacks.onBookUpdated(token.tokenId, book, update),
    );
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

function debugNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function yieldToNextTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
