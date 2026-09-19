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
const RETRY_DELAY_MS = 1_000;

interface SubscriptionBatch {
  readonly id: number;
  readonly handle: SubscriptionHandle<MarketEvent>;
  readonly tokenIds: Set<string>;
}

/**
 * Incremental market-subscription registry.
 *
 * The Polymarket SDK already multiplexes every market subscription created by
 * one PublicClient onto one physical CLOB websocket. These batches are logical
 * handles on that shared socket. Keeping them separate lets us add/remove
 * assets incrementally without rebuilding the connection.
 *
 * Large initial asset lists are deliberately chunked: sending ~1000 restored
 * assets in one subscription frame can leave many tokens waiting a long time
 * for their first snapshot, whereas small incremental subscribe frames hydrate
 * promptly.
 */
export class RecorderSubscriptionPool {
  private readonly batches = new Map<number, SubscriptionBatch>();
  private readonly subscribed = new Set<string>();
  private readonly pending = new Set<string>();
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting = false;
  private stopped = false;
  private nextBatchId = 1;

  constructor(
    private readonly client: PublicClient,
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

  debugStatus(
    tokenIds: Iterable<string>,
  ): Record<
    string,
    { state: "pending" | "subscribed" | "untracked"; batchId?: number }
  > {
    const batchByToken = new Map<string, number>();
    for (const [batchId, batch] of this.batches)
      for (const tokenId of batch.tokenIds)
        batchByToken.set(tokenId, batchId);

    return Object.fromEntries(
      [...tokenIds].map((tokenId) => {
        const batchId = batchByToken.get(tokenId);
        if (batchId !== undefined)
          return [tokenId, { state: "subscribed" as const, batchId }];
        if (this.pending.has(tokenId))
          return [tokenId, { state: "pending" as const }];
        return [tokenId, { state: "untracked" as const }];
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
        batch.tokenIds.delete(tokenId);

      if (batch.tokenIds.size > 0) continue;
      this.batches.delete(id);
      this.onDebug("subscription-retire", `batch=${id}`);
      // Closing a transport is cleanup, not correctness. Some websocket
      // implementations can stall here, so never put it on a critical path.
      void batch.handle.close().catch(() => undefined);
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
    this.subscribed.clear();
    this.pending.clear();

    // Process exit will reclaim sockets. Do not let a websocket close handshake
    // block recorder persistence or Ctrl-C shutdown.
    for (const handle of handles)
      void handle.close().catch(() => undefined);
  }

  private scheduleSubscribe(delayMs = SUBSCRIBE_DEBOUNCE_MS): void {
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
      const handle = await this.open(tokenIds);
      if (!handle) return;

      const id = this.nextBatchId++;
      const batch: SubscriptionBatch = {
        id,
        handle,
        tokenIds: new Set(tokenIds),
      };
      this.batches.set(id, batch);
      for (const tokenId of tokenIds)
        this.subscribed.add(tokenId);

      this.onDebug(
        "subscription-open",
        `batch=${id}`,
        `tokens=${tokenIds.length}`,
        `remaining=${this.pending.size}`,
        `active=${this.batches.size}`,
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

  private async open(
    tokenIds: readonly string[],
  ): Promise<SubscriptionHandle<MarketEvent> | null> {
    while (!this.stopped) {
      try {
        const handle = await this.client.subscribe([
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
        if (!(error instanceof TransportError)) {
          console.error(
            "Recorder websocket subscription failed; retrying…",
            error,
          );
        } else {
          console.error(
            "Recorder websocket connection failed; retrying…",
            error,
          );
        }
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
        console.error("Recorder websocket stream ended with error", error);
    } finally {
      if (this.batches.get(batch.id) !== batch) return;

      this.batches.delete(batch.id);
      this.onDebug(
        "subscription-ended",
        `batch=${batch.id}`,
        `tokens=${batch.tokenIds.size}`,
      );
      for (const tokenId of batch.tokenIds) {
        this.subscribed.delete(tokenId);
        if (!this.stopped) this.pending.add(tokenId);
      }

      if (!this.stopped && this.pending.size > 0)
        this.scheduleSubscribe(RETRY_DELAY_MS);
    }
  }
}
