import {
  TransportError,
  type PublicClient,
} from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";

const SUBSCRIBE_DEBOUNCE_MS = 100;
const SUBSCRIBE_BATCH_GAP_MS = 40;
const MAX_SUBSCRIBE_BATCH_TOKENS = 100;
/**
 * Conservative physical-connection cap.
 *
 * Polymarket does not publish a stable cap, but high subscription counts are
 * observed to silently stop producing snapshots. Each PublicClient owns one
 * CLOB market websocket, so we intentionally shard long-lived recorder
 * subscriptions across clients instead of merely sending smaller logical
 * subscription messages through one socket.
 */
const MAX_TOKENS_PER_CONNECTION = 200;
const RETRY_DELAY_MS = 1_000;

interface SubscriptionShard {
  readonly id: number;
  readonly client: PublicClient;
  readonly batchIds: Set<number>;
  /** Physical assets still subscribed on this client. */
  tokenCount: number;
}

interface SubscriptionBatch {
  readonly id: number;
  readonly shardId: number;
  readonly handle: SubscriptionHandle<MarketEvent>;
  /** Assets owned by this SDK subscription handle. */
  readonly subscribedTokenIds: Set<string>;
  /** Assets that the recorder still cares about. */
  readonly activeTokenIds: Set<string>;
}

/**
 * Incremental recorder subscription pool.
 *
 * Within one PublicClient, the Polymarket SDK multiplexes logical subscription
 * handles onto one physical websocket and sends incremental subscribe frames.
 * We keep that behavior, but cap each physical websocket at a conservative
 * number of assets and create another PublicClient/socket when necessary.
 */
export class RecorderSubscriptionPool {
  private readonly shards = new Map<number, SubscriptionShard>();
  private readonly batches = new Map<number, SubscriptionBatch>();
  private readonly subscribed = new Set<string>();
  private readonly pending = new Set<string>();
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private stopped = false;
  private nextBatchId = 1;
  private nextShardId = 1;

  constructor(
    private readonly createClient: () => PublicClient,
    private readonly onEvent: (event: MarketEvent) => void,
    private readonly onDebug: (...args: unknown[]) => void =
      () => undefined,
  ) {}

  get connected(): boolean {
    return this.batches.size > 0;
  }

  get activeBatchCount(): number {
    return this.batches.size;
  }

  get activeConnectionCount(): number {
    return this.shards.size;
  }

  debugStatus(
    tokenIds: Iterable<string>,
  ): Record<
    string,
    {
      state: "pending" | "subscribed" | "untracked";
      batchId?: number;
      connectionId?: number;
    }
  > {
    const ownerByToken = new Map<
      string,
      { batchId: number; connectionId: number }
    >();
    for (const [batchId, batch] of this.batches) {
      for (const tokenId of batch.activeTokenIds) {
        ownerByToken.set(tokenId, {
          batchId,
          connectionId: batch.shardId,
        });
      }
    }

    return Object.fromEntries(
      [...tokenIds].map((tokenId) => {
        const owner = ownerByToken.get(tokenId);
        if (owner)
          return [
            tokenId,
            {
              state: "subscribed" as const,
              ...owner,
            },
          ];
        if (this.pending.has(tokenId))
          return [
            tokenId,
            { state: "pending" as const },
          ];
        return [
          tokenId,
          { state: "untracked" as const },
        ];
      }),
    );
  }

  add(tokenIds: Iterable<string>): void {
    if (this.stopped) return;

    let changed = false;
    for (const tokenId of tokenIds) {
      if (
        !tokenId ||
        this.subscribed.has(tokenId) ||
        this.pending.has(tokenId)
      )
        continue;
      this.pending.add(tokenId);
      changed = true;
    }

    if (changed) {
      this.onDebug(
        "subscription-queue",
        `pending=${this.pending.size}`,
        `connections=${this.shards.size}`,
        `batches=${this.batches.size}`,
      );
      this.scheduleSubscribe();
    }
  }

  remove(tokenIds: Iterable<string>): void {
    const removed = new Set(tokenIds);
    if (removed.size === 0) return;

    for (const tokenId of removed) {
      this.pending.delete(tokenId);
      this.subscribed.delete(tokenId);
    }

    for (const [id, batch] of this.batches) {
      for (const tokenId of removed)
        batch.activeTokenIds.delete(tokenId);

      // A logical SDK handle cannot partially release its original asset list.
      // Keep resolved assets physically subscribed until this handle has no
      // active recorder tokens, then close the whole handle in one operation.
      if (batch.activeTokenIds.size > 0) continue;
      this.retireBatch(id, batch);
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.subscribeTimer !== undefined) {
      clearTimeout(this.subscribeTimer);
      this.subscribeTimer = undefined;
    }

    const handles = [...this.batches.values()].map(
      (batch) => batch.handle,
    );
    this.batches.clear();
    this.shards.clear();
    this.subscribed.clear();
    this.pending.clear();

    // Process exit will reclaim sockets. Do not let websocket close handshakes
    // block recorder persistence or Ctrl-C shutdown.
    for (const handle of handles)
      void handle.close().catch(() => undefined);
  }

  private scheduleSubscribe(
    delayMs = SUBSCRIBE_DEBOUNCE_MS,
  ): void {
    if (
      this.stopped ||
      this.subscribeTimer !== undefined ||
      this.pending.size === 0
    )
      return;

    this.subscribeTimer = setTimeout(() => {
      this.subscribeTimer = undefined;
      void this.flushPending();
    }, delayMs);
  }

  private async flushPending(): Promise<void> {
    if (this.stopped) return;
    if (this.connecting) {
      this.scheduleSubscribe();
      return;
    }

    const tokenIds = [...this.pending]
      .filter(
        (tokenId) => !this.subscribed.has(tokenId),
      )
      .slice(0, MAX_SUBSCRIBE_BATCH_TOKENS);
    for (const tokenId of tokenIds)
      this.pending.delete(tokenId);
    if (tokenIds.length === 0) return;

    this.connecting = true;
    try {
      const shard = this.pickShard(tokenIds.length);
      const handle = await this.open(
        shard.client,
        tokenIds,
      );
      if (!handle) return;

      const id = this.nextBatchId++;
      const batch: SubscriptionBatch = {
        id,
        shardId: shard.id,
        handle,
        subscribedTokenIds: new Set(tokenIds),
        activeTokenIds: new Set(tokenIds),
      };
      this.batches.set(id, batch);
      shard.batchIds.add(id);
      shard.tokenCount += tokenIds.length;
      for (const tokenId of tokenIds)
        this.subscribed.add(tokenId);

      this.onDebug(
        "subscription-open",
        `connection=${shard.id}`,
        `batch=${id}`,
        `tokens=${tokenIds.length}`,
        `connectionTokens=${shard.tokenCount}`,
        `remaining=${this.pending.size}`,
        `connections=${this.shards.size}`,
      );
      void this.consume(batch);
    } finally {
      this.connecting = false;
      if (this.pending.size > 0)
        this.scheduleSubscribe(
          SUBSCRIBE_BATCH_GAP_MS,
        );
    }
  }

  private pickShard(tokenCount: number): SubscriptionShard {
    for (const shard of this.shards.values()) {
      if (
        shard.tokenCount + tokenCount <=
        MAX_TOKENS_PER_CONNECTION
      )
        return shard;
    }

    const shard: SubscriptionShard = {
      id: this.nextShardId++,
      client: this.createClient(),
      batchIds: new Set(),
      tokenCount: 0,
    };
    this.shards.set(shard.id, shard);
    this.onDebug(
      "connection-create",
      `connection=${shard.id}`,
      `active=${this.shards.size}`,
    );
    return shard;
  }

  private async open(
    client: PublicClient,
    tokenIds: readonly string[],
  ): Promise<SubscriptionHandle<MarketEvent> | null> {
    while (!this.stopped) {
      try {
        const handle = await client.subscribe([
          {
            topic: "market",
            tokenIds,
            customFeatureEnabled: true,
          },
        ]);
        if (this.stopped) {
          void handle.close().catch(() => undefined);
          return null;
        }
        return handle;
      } catch (error) {
        console.error(
          error instanceof TransportError
            ? "Recorder websocket connection failed; retrying…"
            : "Recorder websocket subscription failed; retrying…",
          error,
        );
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
    return null;
  }

  private async consume(batch: SubscriptionBatch): Promise<void> {
    try {
      for await (const event of batch.handle) {
        if (
          this.stopped ||
          this.batches.get(batch.id) !== batch
        )
          return;
        this.onEvent(event);
      }
    } catch (error) {
      if (!this.stopped)
        console.error(
          "Recorder websocket stream ended with error",
          error,
        );
    } finally {
      if (this.batches.get(batch.id) !== batch) return;

      const active = [...batch.activeTokenIds];
      this.retireBatch(batch.id, batch);
      for (const tokenId of active) {
        this.subscribed.delete(tokenId);
        if (!this.stopped)
          this.pending.add(tokenId);
      }

      if (!this.stopped && this.pending.size > 0)
        this.scheduleSubscribe(RETRY_DELAY_MS);
    }
  }

  private retireBatch(
    id: number,
    batch: SubscriptionBatch,
  ): void {
    this.batches.delete(id);

    const shard = this.shards.get(batch.shardId);
    if (shard) {
      shard.batchIds.delete(id);
      shard.tokenCount = Math.max(
        0,
        shard.tokenCount -
          batch.subscribedTokenIds.size,
      );
      if (shard.batchIds.size === 0)
        this.shards.delete(shard.id);
    }

    this.onDebug(
      "subscription-retire",
      `connection=${batch.shardId}`,
      `batch=${id}`,
    );
    void batch.handle.close().catch(() => undefined);
  }
}
