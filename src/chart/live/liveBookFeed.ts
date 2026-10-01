import type { TokenBook } from "@/domain/books/orderBook";
import { liveBookCoordinator } from "./liveBookCoordinator";
import type { LiveBookFeedCallbacks, LiveBookWatch } from "./liveBookContracts";
import type { PublicClient, TokenId } from "@polymarket/client";

type FeedState =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly watch: LiveBookWatch }
  | { readonly kind: "live"; readonly watch: LiveBookWatch }
  | { readonly kind: "destroyed" };

/** Per-view lifecycle wrapper around the client-wide live-book coordinator. */
export class LiveBookFeed {
  private readonly coordinator: ReturnType<typeof liveBookCoordinator>;
  private state: FeedState = { kind: "idle" };
  private readonly tokenKeys = new Set<TokenId>();

  constructor(
    client: PublicClient,
    private readonly callbacks: LiveBookFeedCallbacks,
  ) {
    this.coordinator = liveBookCoordinator(client);
  }

  getBook(tokenId: TokenId): TokenBook | undefined {
    if (!this.tokenKeys.has(tokenId)) return undefined;
    return this.coordinator.getBook(tokenId);
  }

  async start(tokenIds: readonly TokenId[]): Promise<void> {
    if (this.state.kind !== "idle")
      throw new Error(`LiveBookFeed cannot start from ${this.state.kind}`);

    this.tokenKeys.clear();
    for (const tokenId of tokenIds) this.tokenKeys.add(tokenId);
    const watch = this.coordinator.watch(tokenIds, this.callbacks);
    this.state = { kind: "starting", watch };

    try {
      await watch.ready;
    } catch (error) {
      if (this.state.kind === "starting" && this.state.watch === watch) {
        this.state = { kind: "idle" };
        this.tokenKeys.clear();
      }
      throw error;
    }

    if (this.state.kind === "starting" && this.state.watch === watch)
      this.state = { kind: "live", watch };
  }

  destroy(): void {
    const previous = this.state;
    if (previous.kind === "destroyed") return;

    this.state = { kind: "destroyed" };
    this.tokenKeys.clear();
    if (previous.kind === "starting" || previous.kind === "live")
      previous.watch.close();
  }
}
