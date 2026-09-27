import type { ConnectionStatus } from "@/lib/chartState";
import {
  bookRefreshCoordinator,
  type BookRefreshSnapshot,
  type BookRefreshSubscriber,
} from "./bookRefreshCoordinator";
import {
  applyPriceChange,
  bookFromSnapshot,
  type CanonicalBookChange,
  type RawPriceChange,
} from "@/lib/bookIngestion";
import type { MarketResolutionUpdate } from "@/lib/marketLifecycle";
import type { TokenBook } from "@/lib/orderBook";
import {
  TransportError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";

type FeedState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | {
      readonly kind: "live";
      readonly stream: SubscriptionHandle<MarketEvent>;
      readonly snapshotRequestedAtMs: number;
    }
  | { readonly kind: "ended" }
  | { readonly kind: "destroyed" };

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

interface BufferedBookDelta {
  readonly timestampMs: number;
  readonly changes: readonly RawPriceChange[];
}

interface BookRefreshContext {
  readonly stream: SubscriptionHandle<MarketEvent>;
  readonly requestId: number;
  readonly requestedAtMs: number;
  readonly buffered: BufferedBookDelta[];
  superseded: boolean;
}

export interface LiveBookFeedCallbacks {
  readonly onConnectionStatus: (status: ConnectionStatus) => void;
  readonly onBookUpdated: (
    tokenId: TokenId,
    book: TokenBook,
    update: LiveBookUpdate,
  ) => void;
  readonly onMarketResolved: (resolution: MarketResolutionUpdate) => void;
}

export class LiveBookFeed {
  private readonly books = new Map<TokenId, TokenBook>();
  private readonly tokenIdByValue = new Map<string, TokenId>();
  private state: FeedState = { kind: "idle" };
  private tokenIds: TokenId[] = [];
  private readonly refreshContexts = new Map<TokenId, BookRefreshContext>();
  private readonly refreshCoordinator: ReturnType<
    typeof bookRefreshCoordinator
  >;
  private readonly refreshSubscriber: BookRefreshSubscriber = {
    onBookRefreshStarted: (tokenId, requestId, requestedAtMs) =>
      this.beginBookRefresh(tokenId, requestId, requestedAtMs),
    onBookRefreshSnapshot: (tokenId, requestId, requestedAtMs, snapshot) =>
      this.applyBookRefresh(tokenId, requestId, requestedAtMs, snapshot),
    onBookRefreshFinished: (tokenId, requestId) =>
      this.finishBookRefresh(tokenId, requestId),
  };

  constructor(
    private readonly client: PublicClient,
    private readonly callbacks: LiveBookFeedCallbacks,
  ) {
    this.refreshCoordinator = bookRefreshCoordinator(client);
  }

  getBook(tokenId: TokenId): TokenBook | undefined {
    return this.books.get(tokenId);
  }

  async start(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.state.kind !== "idle")
      throw new Error(`LiveBookFeed cannot start from ${this.state.kind}`);

    this.tokenIds = [...tokenIds];
    this.tokenIdByValue.clear();
    for (const tokenId of tokenIds) this.tokenIdByValue.set(tokenId, tokenId);
    this.state = { kind: "connecting" };
    this.callbacks.onConnectionStatus("connecting");
    await this.connect();
  }

  destroy(): void {
    const previous = this.state;
    if (previous.kind === "destroyed") return;
    this.state = { kind: "destroyed" };
    this.tokenIds = [];
    this.tokenIdByValue.clear();
    this.books.clear();
    this.refreshContexts.clear();
    this.refreshCoordinator.unwatchAll(this.refreshSubscriber);

    if (previous.kind === "live")
      void previous.stream.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const subscription = await this.subscribeWithRetry(this.tokenIds);
    if (!subscription) return;

    if (this.state.kind !== "connecting") {
      await subscription.stream.close().catch(() => undefined);
      return;
    }

    this.state = { kind: "live", ...subscription };
    this.callbacks.onConnectionStatus("live");
    void this.readEvents(
      subscription.stream,
      subscription.snapshotRequestedAtMs,
    );
  }

  private reconnect(): void {
    if (this.state.kind === "destroyed") return;

    // A disconnected snapshot is no longer authoritative. Keep historical
    // pressure in AgeStripPressureState, but require fresh book snapshots for
    // live tooltips/updates after reconnect.
    this.books.clear();
    this.refreshContexts.clear();
    this.refreshCoordinator.unwatchAll(this.refreshSubscriber);
    this.state = { kind: "connecting" };
    this.callbacks.onConnectionStatus("connecting");
    void this.connect();
  }

  private async subscribeWithRetry(tokenIds: readonly TokenId[]): Promise<{
    readonly stream: SubscriptionHandle<MarketEvent>;
    readonly snapshotRequestedAtMs: number;
  } | null> {
    while (this.state.kind === "connecting") {
      try {
        const snapshotRequestedAtMs = Date.now();
        const stream = await this.client.subscribe([
          {
            topic: "market",
            tokenIds: [...tokenIds],
            customFeatureEnabled: true,
          },
        ]);
        if (this.state.kind === "connecting")
          return { stream, snapshotRequestedAtMs };
        await stream.close().catch(() => undefined);
        return null;
      } catch (error) {
        if (this.state.kind !== "connecting") return null;
        if (!(error instanceof TransportError)) throw error;
        console.error("Error connecting to websocket; retrying in 1s", error);
        await delay(1_000);
      }
    }
    return null;
  }

  private async readEvents(
    stream: SubscriptionHandle<MarketEvent>,
    snapshotRequestedAtMs: number,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.state.kind !== "live" || this.state.stream !== stream) return;

        if (event.type === "book") {
          const tokenId = this.tokenIdByValue.get(event.payload.assetId);
          if (tokenId) {
            const refresh = this.refreshContexts.get(tokenId);
            if (refresh?.stream === stream) refresh.superseded = true;

            const book = bookFromSnapshot(
              event.payload.bids,
              event.payload.asks,
            );
            const validThroughMs = snapshotValidThroughMs(
              event.payload.timestamp,
              snapshotRequestedAtMs,
            );
            this.books.set(tokenId, book);
            this.callbacks.onBookUpdated(tokenId, book, {
              kind: "snapshot",
              validThroughMs,
            });
            this.observeBook(tokenId, validThroughMs);
          }
        } else if (event.type === "price_change") {
          const validThroughMs = eventTimeMs(event.payload.timestamp);
          const changesByToken = new Map<
            TokenId,
            {
              canonical: CanonicalBookChange[];
              raw: RawPriceChange[];
            }
          >();

          for (const change of event.payload.priceChanges) {
            const tokenId = this.tokenIdByValue.get(change.assetId);
            if (!tokenId) continue;

            const book = this.books.get(tokenId);
            if (!book) continue;

            const changes = changesByToken.get(tokenId) ?? {
              canonical: [],
              raw: [],
            };
            const raw: RawPriceChange = {
              side: change.side,
              price: change.price,
              size: change.size,
            };
            changes.raw.push(raw);
            changes.canonical.push(applyPriceChange(book, raw));
            changesByToken.set(tokenId, changes);
          }

          for (const [tokenId, changes] of changesByToken) {
            const book = this.books.get(tokenId);
            if (!book) continue;

            const refresh = this.refreshContexts.get(tokenId);
            if (refresh?.stream === stream && !refresh.superseded)
              refresh.buffered.push({
                timestampMs: validThroughMs,
                changes: changes.raw,
              });

            this.callbacks.onBookUpdated(tokenId, book, {
              kind: "levels",
              validThroughMs,
              changes: changes.canonical,
            });
            this.observeBook(tokenId, validThroughMs);
          }
        } else if (event.type === "market_resolved") {
          const assetIds = event.payload.assetIds ?? [];
          for (const assetId of assetIds) {
            const tokenId = this.tokenIdByValue.get(assetId);
            if (!tokenId) continue;
            this.books.delete(tokenId);
            this.refreshContexts.delete(tokenId);
            this.refreshCoordinator.unwatch(this.refreshSubscriber, tokenId);
          }

          this.callbacks.onMarketResolved({
            conditionId: event.payload.conditionId,
            assetIds,
            winningAssetId: event.payload.winningAssetId ?? null,
            winningOutcome: event.payload.winningOutcome ?? null,
          });
        }
      }
    } catch (error) {
      if (this.state.kind === "live" && this.state.stream === stream)
        console.error("Market websocket stream ended with error", error);
    } finally {
      if (this.state.kind === "live" && this.state.stream === stream) {
        this.state = { kind: "ended" };
        this.callbacks.onConnectionStatus("disconnected");
        this.reconnect();
      }
    }
  }

  private observeBook(tokenId: TokenId, validThroughMs: number): void {
    this.refreshCoordinator.observe(
      this.refreshSubscriber,
      tokenId,
      validThroughMs,
    );
  }

  private beginBookRefresh(
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
  ): void {
    const state = this.state;
    if (
      state.kind !== "live" ||
      !this.books.has(tokenId) ||
      !this.tokenIdByValue.has(String(tokenId))
    )
      return;

    this.refreshContexts.set(tokenId, {
      stream: state.stream,
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
    const context = this.refreshContexts.get(tokenId);
    const state = this.state;
    if (
      !context ||
      context.requestId !== requestId ||
      context.requestedAtMs !== requestedAtMs ||
      context.superseded ||
      state.kind !== "live" ||
      state.stream !== context.stream
    )
      return;

    const snapshotTokenId = this.tokenIdByValue.get(String(snapshot.assetId));
    if (snapshotTokenId !== tokenId) return;

    const snapshotTimestampMs = eventTimeMs(snapshot.timestamp, requestedAtMs);
    const book = bookFromSnapshot(snapshot.bids, snapshot.asks);
    let validThroughMs = Math.max(requestedAtMs, snapshotTimestampMs);

    for (const delta of context.buffered) {
      if (delta.timestampMs <= snapshotTimestampMs) continue;
      for (const change of delta.changes) applyPriceChange(book, change);
      validThroughMs = Math.max(validThroughMs, delta.timestampMs);
    }

    this.books.set(tokenId, book);
    this.callbacks.onBookUpdated(tokenId, book, {
      kind: "snapshot",
      validThroughMs,
    });
    this.observeBook(tokenId, validThroughMs);
  }

  private finishBookRefresh(tokenId: TokenId, requestId: number): void {
    if (this.refreshContexts.get(tokenId)?.requestId === requestId)
      this.refreshContexts.delete(tokenId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function snapshotValidThroughMs(
  value: unknown,
  snapshotRequestedAtMs: number,
): number {
  return Math.max(
    snapshotRequestedAtMs,
    eventTimeMs(value, snapshotRequestedAtMs),
  );
}

function eventTimeMs(value: unknown, fallbackMs = Date.now()): number {
  const nowMs = Date.now();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) &&
    timestamp >= 0 &&
    timestamp <= nowMs + 60_000
    ? timestamp
    : fallbackMs;
}
