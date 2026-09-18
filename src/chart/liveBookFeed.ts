import type { ConnectionStatus } from "@/lib/chartState";
import {
  HalfBook,
  type TokenBook,
} from "@/lib/orderBook";
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

export interface LiveBookFeedCallbacks {
  readonly onConnectionStatus: (status: ConnectionStatus) => void;
  readonly onBookUpdated: (tokenId: TokenId) => void;
  readonly onMarketResolved: (tokenIds: readonly TokenId[]) => void;
}

export class LiveBookFeed {
  private readonly books = new Map<string, TokenBook<string>>();
  private state: FeedState = { kind: "idle" };

  constructor(
    private readonly client: PublicClient,
    private readonly callbacks: LiveBookFeedCallbacks,
  ) {}

  getBook(tokenId: string): TokenBook<string> | undefined {
    return this.books.get(String(tokenId));
  }

  async start(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.state.kind !== "idle")
      throw new Error(
        `LiveBookFeed cannot start from ${this.state.kind}`,
      );

    this.state = { kind: "connecting" };
    this.callbacks.onConnectionStatus("connecting");

    const stream = await this.subscribeWithRetry(tokenIds);
    if (!stream) return;

    if (this.state.kind === "destroyed") {
      await stream.close().catch(() => undefined);
      return;
    }

    this.state = { kind: "live", stream };
    this.callbacks.onConnectionStatus("live");
    void this.readEvents(stream);
  }

  destroy(): void {
    const previous = this.state;
    if (previous.kind === "destroyed") return;
    this.state = { kind: "destroyed" };

    if (previous.kind === "live")
      void previous.stream.close().catch(() => undefined);
  }

  private async subscribeWithRetry(
    tokenIds: readonly TokenId[],
  ): Promise<SubscriptionHandle<MarketEvent> | null> {
    while (this.state.kind === "connecting") {
      try {
        const stream = await this.client.subscribe([
          { topic: "market", tokenIds: [...tokenIds] },
        ]);
        if (this.state.kind === "connecting") return stream;
        await stream.close().catch(() => undefined);
        return null;
      } catch (error) {
        if (this.state.kind !== "connecting") return null;
        if (!(error instanceof TransportError)) throw error;
        console.error(
          "Error connecting to websocket; retrying in 1s",
          error,
        );
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
        if (
          this.state.kind !== "live" ||
          this.state.stream !== stream
        )
          return;

        if (event.type === "book") {
          const tokenId = event.payload.tokenId as TokenId;
          this.books.set(
            String(tokenId),
            bookFromSnapshot(event.payload.bids, event.payload.asks),
          );
          this.callbacks.onBookUpdated(tokenId);
          continue;
        }

        if (event.type === "price_change") {
          const touched = new Set<TokenId>();
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
            touched.add(tokenId);
          }
          for (const tokenId of touched)
            this.callbacks.onBookUpdated(tokenId);
          continue;
        }

        if (event.type === "market_resolved") {
          this.callbacks.onMarketResolved(
            (event.payload.assetIds ?? []).map(
              (tokenId) => tokenId as TokenId,
            ),
          );
        }
      }
    } catch (error) {
      if (
        this.state.kind === "live" &&
        this.state.stream === stream
      )
        console.error("Market websocket stream ended with error", error);
    } finally {
      if (
        this.state.kind === "live" &&
        this.state.stream === stream
      ) {
        this.state = { kind: "ended" };
        this.callbacks.onConnectionStatus("disconnected");
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
