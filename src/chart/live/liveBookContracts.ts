import type { MarketResolutionUpdate } from "@/domain/markets/marketLifecycle";
import type { TokenBook } from "@/domain/books/orderBook";
import type { Price } from "@/domain/books/price";
import type { TokenId } from "@polymarket/client";

export type LiveBookUpdate =
  | {
      /** Complete observation after a stream discontinuity. */
      readonly kind: "snapshot";
      readonly validThroughMs: number;
    }
  | {
      /** Complete replacement on one continuous ordered stream. */
      readonly kind: "replace";
      readonly validThroughMs: number;
    }
  | {
      readonly kind: "levels";
      readonly validThroughMs: number;
      readonly changes: readonly {
        readonly side: "bid" | "ask";
        readonly price: Price;
        readonly shares: number;
      }[];
    }
  | {
      /** Same-market ordered evidence with no token-local geometry change. */
      readonly kind: "watermark";
      readonly validThroughMs: number;
    };

export interface LiveBookFeedCallbacks {
  readonly onConnectionStatus: (
    status: import("@/domain/markets/chartState").ConnectionStatus,
  ) => void;
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

export type LiveBookTransportState =
  "idle" | "closing" | "connecting" | "handoff" | "retrying" | "streaming";

export interface LiveBookNetworkState {
  readonly transport: LiveBookTransportState;
  readonly desiredTokens: number;
  readonly subscribedTokens: number;
  readonly synchronizedBooks: number;
  readonly cachedBooks: number;
  readonly awaitingSnapshots: number;
  readonly refreshingTokens: number;
  readonly watchers: number;
  readonly coveredWatchers: number;
  readonly activeHandles: number;
  readonly reconciling: boolean;
  readonly reconcileScheduled: boolean;
  readonly revision: number;
  readonly retryAtMs: number | null;
}

export type LiveBookNetworkSubscriber = (state: LiveBookNetworkState) => void;
