import type { ConnectionStatus } from "@/lib/chartState";
import type { MarketResolutionUpdate } from "@/lib/marketLifecycle";
import { HalfBook, type TokenBook } from "@/lib/orderBook";
import {
  OrderSide,
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
    }
  | { readonly kind: "ended" }
  | { readonly kind: "destroyed" };

export type LiveBookUpdate =
  | {
      readonly kind: "snapshot";
      readonly observedAtMs: number;
    }
  | {
      readonly kind: "levels";
      readonly observedAtMs: number;
      readonly changes: readonly {
        readonly side: "bid" | "ask";
        readonly price: number;
        readonly shares: number;
      }[];
    };

export interface LiveBookFeedCallbacks {
  readonly onConnectionStatus: (status: ConnectionStatus) => void;
  readonly onBookUpdated: (
    tokenId: TokenId,
    book: TokenBook<string>,
    update: LiveBookUpdate,
  ) => void;
  readonly onMarketResolved: (resolution: MarketResolutionUpdate) => void;
}

export class LiveBookFeed {
  private readonly books = new Map<string, TokenBook<string>>();
  private state: FeedState = { kind: "idle" };
  private tokenIds: TokenId[] = [];

  constructor(
    private readonly client: PublicClient,
    private readonly callbacks: LiveBookFeedCallbacks,
  ) {}

  getBook(tokenId: string): TokenBook<string> | undefined {
    return this.books.get(String(tokenId));
  }

  async start(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.state.kind !== "idle")
      throw new Error(`LiveBookFeed cannot start from ${this.state.kind}`);

    this.tokenIds = [...tokenIds];
    this.state = { kind: "connecting" };
    this.callbacks.onConnectionStatus("connecting");
    await this.connect();
  }

  destroy(): void {
    const previous = this.state;
    if (previous.kind === "destroyed") return;
    this.state = { kind: "destroyed" };
    this.tokenIds = [];
    this.books.clear();

    if (previous.kind === "live")
      void previous.stream.close().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const stream = await this.subscribeWithRetry(this.tokenIds);
    if (!stream) return;

    if (this.state.kind !== "connecting") {
      await stream.close().catch(() => undefined);
      return;
    }

    this.state = { kind: "live", stream };
    this.callbacks.onConnectionStatus("live");
    void this.readEvents(stream);
  }

  private reconnect(): void {
    if (this.state.kind === "destroyed") return;

    // A disconnected snapshot is no longer authoritative. Keep historical
    // pressure in AgeStripPressureState, but require fresh book snapshots for
    // live tooltips/updates after reconnect.
    this.books.clear();
    this.state = { kind: "connecting" };
    this.callbacks.onConnectionStatus("connecting");
    void this.connect();
  }

  private async subscribeWithRetry(
    tokenIds: readonly TokenId[],
  ): Promise<SubscriptionHandle<MarketEvent> | null> {
    while (this.state.kind === "connecting") {
      try {
        const stream = await this.client.subscribe([
          {
            topic: "market",
            tokenIds: [...tokenIds],
            customFeatureEnabled: true,
          },
        ]);
        if (this.state.kind === "connecting") return stream;
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
  ): Promise<void> {
    try {
      for await (const event of stream) {
        if (this.state.kind !== "live" || this.state.stream !== stream) return;

        if (event.type === "book") {
          const tokenId = event.payload.tokenId as TokenId;
          const book = bookFromSnapshot(event.payload.bids, event.payload.asks);
          this.books.set(String(tokenId), book);
          this.callbacks.onBookUpdated(tokenId, book, {
            kind: "snapshot",
            observedAtMs: observationTimeMs(),
          });
          continue;
        }

        if (event.type === "price_change") {
          const changesByToken = new Map<
            TokenId,
            Array<{
              side: "bid" | "ask";
              price: number;
              shares: number;
            }>
          >();

          for (const change of event.payload.priceChanges) {
            const tokenId = change.tokenId as TokenId;
            const book = this.books.get(String(tokenId));
            if (!book) continue;

            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            if (change.side === OrderSide.BUY) {
              book.usdToYes.setLevel(change.price, {
                price,
                take: size,
              });
            } else {
              book.yesToUsd.setLevel(change.price, {
                price: 1 / price,
                take: size * price,
              });
            }

            const changes = changesByToken.get(tokenId) ?? [];
            changes.push({
              side: change.side === OrderSide.BUY ? "bid" : "ask",
              price,
              shares: size,
            });
            changesByToken.set(tokenId, changes);
          }

          const observedAtMs = observationTimeMs();
          for (const [tokenId, changes] of changesByToken) {
            const book = this.books.get(String(tokenId));
            if (!book) continue;
            this.callbacks.onBookUpdated(tokenId, book, {
              kind: "levels",
              observedAtMs,
              changes,
            });
          }
          continue;
        }

        if (event.type === "market_resolved") {
          const assetIds = (event.payload.assetIds ?? []).map(String);
          for (const tokenId of assetIds) this.books.delete(tokenId);

          this.callbacks.onMarketResolved({
            conditionId: String(event.payload.conditionId),
            assetIds,
            winningTokenId: event.payload.winningAssetId
              ? String(event.payload.winningAssetId)
              : null,
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
}

function bookFromSnapshot(
  bids: readonly { readonly price: string; readonly size: string }[],
  asks: readonly { readonly price: string; readonly size: string }[],
): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  for (const bid of bids) {
    usdToYes.setLevel(bid.price, {
      price: parseFloat(bid.price),
      take: parseFloat(bid.size),
    });
  }

  const yesToUsd = new HalfBook<string>();
  for (const ask of asks) {
    const canonicalPrice = parseFloat(ask.price);
    yesToUsd.setLevel(ask.price, {
      price: 1 / canonicalPrice,
      take: parseFloat(ask.size) * canonicalPrice,
    });
  }
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });

  return { usdToYes, yesToUsd };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function observationTimeMs(): number {
  // Pressure history is defined by the order in which this client observes
  // and applies book states. Exchange timestamps may arrive out of order.
  // performance.timeOrigin + performance.now() gives us epoch-compatible,
  // monotonic time for ghost aging without trusting transport ordering.
  return performance.timeOrigin + performance.now();
}
