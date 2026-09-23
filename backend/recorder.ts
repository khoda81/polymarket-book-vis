import { resolve } from "node:path";
import { createPublicClient, OrderSide } from "@polymarket/client";
import type { MarketEvent } from "@polymarket/client/actions";
import { RecorderStore } from "./recorderStore";
import { RecorderSubscriptionPool } from "./recorderSubscriptionPool";
import {
  applyPriceChange,
  bookFromSnapshot,
  type CanonicalBookChange,
} from "../src/lib/bookIngestion";
import type { TokenBook } from "../src/lib/orderBook";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import type { PressureFrontierSnapshot } from "../src/lib/pressureFrontierSnapshot";

const PORT = Number(process.env.RECORDER_PORT ?? 3001);
const LEGACY_STATE_PATH = resolve(
  process.env.RECORDER_STATE_PATH ?? ".data/age-recorder.json",
);
const DATABASE_PATH = resolve(
  process.env.RECORDER_DB_PATH ?? sqlitePathFor(LEGACY_STATE_PATH),
);
const PERSIST_DEBOUNCE_MS = Number(process.env.RECORDER_PERSIST_MS ?? 1_000);
const PERSIST_BATCH_TOKENS = Number(
  process.env.RECORDER_PERSIST_BATCH_TOKENS ?? 8,
);
const REST_SEED_BATCH_TOKENS = 20;
const REST_SEED_RETRY_MS = 5_000;
const RECORDER_DEBUG = process.env.RECORDER_DEBUG === "1";

interface BufferedPriceChangeEvent {
  readonly timestampMs: number;
  readonly changes: readonly {
    side: OrderSide;
    price: string;
    size: string;
  }[];
}

interface TransportState {
  pressure: PressureFrontierSnapshot;
}

interface StateResponse {
  serverNowMs: number;
  connected: boolean;
  /** Earliest instant for which all requested tokens have recorder coverage. */
  recordingSinceMs: number | null;
  /** Recorder coverage start for each requested token. */
  recordingSinceMsByToken: Record<string, number>;
  states: Record<string, TransportState>;
  /** Watched tokens that have not produced their first recorder snapshot yet. */
  pendingTokenIds: string[];
  debug?: {
    subscriptionConnections: number;
    subscriptionBatches: number;
    tokens: Record<
      string,
      {
        watched: boolean;
        completed: boolean;
        hasBook: boolean;
        hasMemory: boolean;
        historyLayers: number;
        recordingSinceMs: number | null;
        seedInFlight: boolean;
        bufferedPriceChanges: number;
        subscription:
          | {
              state: "pending" | "subscribed" | "untracked";
              batchId?: number;
              connectionId?: number;
            }
          | undefined;
      }
    >;
  };
}

class AgeRecorder {
  private readonly store = new RecorderStore(DATABASE_PATH, (...args) =>
    debugLog(...args),
  );
  private readonly watched = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly recordingSince = new Map<string, number>();
  private readonly snapshotClient = createPublicClient();
  private readonly books = new Map<string, TokenBook>();
  private readonly memories = new Map<string, PressureFrontierMemory>();
  private readonly storedPressureTokens = new Set<string>();
  private readonly pendingPriceChanges = new Map<
    string,
    BufferedPriceChangeEvent[]
  >();
  private readonly seedInFlight = new Set<string>();
  private readonly seedRetryAfterMs = new Map<string, number>();
  private readonly dirtyTokens = new Set<string>();
  private readonly subscriptions = new RecorderSubscriptionPool(
    () => createPublicClient(),
    (event) => this.consumeEvent(event),
    (...args) => debugLog(...args),
  );
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    this.store.migrateLegacyJson(LEGACY_STATE_PATH);
    this.restoreFromStore();
    this.subscriptions.add(this.watched);
  }

  async stop(): Promise<void> {
    const startedAt = performance.now();

    this.subscriptions.stop();
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }

    if (this.persistPromise) await this.persistPromise;
    while (this.dirtyTokens.size > 0) await this.flushDirtyPass();

    this.store.checkpoint();
    this.store.close();

    console.log(
      `Recorder state flushed in ${Math.round(
        performance.now() - startedAt,
      )}ms`,
    );
  }

  watch(tokenIds: Iterable<string>): boolean {
    const added: string[] = [];
    for (const tokenId of tokenIds) {
      if (!tokenId || this.watched.has(tokenId) || this.completed.has(tokenId))
        continue;

      this.watched.add(tokenId);
      added.push(tokenId);
    }
    if (added.length === 0) return false;

    this.markDirty(added);
    this.subscriptions.add(added);
    debugLog(
      "watch",
      added.map(shortToken),
      `watched=${this.watched.size}`,
      `batches=${this.subscriptions.activeBatchCount}`,
    );
    return true;
  }

  seedPending(tokenIds: Iterable<string>): void {
    const nowMs = Date.now();
    const candidates = [...new Set(tokenIds)].filter(
      (tokenId) =>
        this.watched.has(tokenId) &&
        !this.completed.has(tokenId) &&
        !this.memories.has(tokenId) &&
        !this.storedPressureTokens.has(tokenId) &&
        !this.seedInFlight.has(tokenId) &&
        (this.seedRetryAfterMs.get(tokenId) ?? 0) <= nowMs,
    );

    for (
      let offset = 0;
      offset < candidates.length;
      offset += REST_SEED_BATCH_TOKENS
    ) {
      const batch = candidates.slice(offset, offset + REST_SEED_BATCH_TOKENS);
      for (const tokenId of batch) this.seedInFlight.add(tokenId);
      void this.seedFromRest(batch);
    }
  }

  state(
    tokenIds: Iterable<string>,
    includeStates = true,
    includeDebug = false,
  ): StateResponse {
    const requested = [...tokenIds];
    const nowMs = Date.now();
    const states: Record<string, TransportState> = {};

    if (includeStates) {
      for (const tokenId of requested) {
        const memory = this.ensureMemory(tokenId);
        if (!memory) continue;
        states[tokenId] = {
          pressure: memory.snapshot(),
        };
      }
    }

    const coverageStarts = requested
      .map((tokenId) => this.recordingSince.get(tokenId))
      .filter((value): value is number => value !== undefined);
    const recordingSinceMs =
      requested.length > 0 && coverageStarts.length === requested.length
        ? Math.max(...coverageStarts)
        : null;

    const recordingSinceMsByToken = Object.fromEntries(
      requested.flatMap((tokenId) => {
        const since = this.recordingSince.get(tokenId);
        return since === undefined ? [] : [[tokenId, since] as const];
      }),
    );

    const pendingTokenIds = requested.filter(
      (tokenId) =>
        this.watched.has(tokenId) &&
        !this.memories.has(tokenId) &&
        !this.storedPressureTokens.has(tokenId),
    );

    const result: StateResponse = {
      serverNowMs: nowMs,
      connected: this.subscriptions.connected,
      recordingSinceMs,
      recordingSinceMsByToken,
      states,
      pendingTokenIds,
    };

    if (includeDebug) {
      const subscription = this.subscriptions.debugStatus(requested);
      result.debug = {
        subscriptionConnections: this.subscriptions.activeConnectionCount,
        subscriptionBatches: this.subscriptions.activeBatchCount,
        tokens: Object.fromEntries(
          requested.map((tokenId) => {
            const memory = this.memories.get(tokenId);
            return [
              tokenId,
              {
                watched: this.watched.has(tokenId),
                completed: this.completed.has(tokenId),
                hasBook: this.books.has(tokenId),
                hasMemory: memory !== undefined,
                historyLayers: memory
                  ? memory.historyDepth("bid") + memory.historyDepth("ask")
                  : 0,
                recordingSinceMs: this.recordingSince.get(tokenId) ?? null,
                seedInFlight: this.seedInFlight.has(tokenId),
                bufferedPriceChanges:
                  this.pendingPriceChanges.get(tokenId)?.length ?? 0,
                subscription: subscription[tokenId],
              },
            ];
          }),
        ),
      };
    }

    return result;
  }

  stats() {
    const starts = [...this.recordingSince.values()];
    return {
      watchedTokens: this.watched.size,
      completedTokens: this.completed.size,
      hydratedTokens: this.memories.size,
      liveBooks: this.books.size,
      connected: this.subscriptions.connected,
      subscriptionConnections: this.subscriptions.activeConnectionCount,
      subscriptionBatches: this.subscriptions.activeBatchCount,
      dirtyTokens: this.dirtyTokens.size,
      oldestRecordingSinceMs: starts.length ? Math.min(...starts) : null,
      newestRecordingSinceMs: starts.length ? Math.max(...starts) : null,
      databasePath: DATABASE_PATH,
    };
  }

  private consumeEvent(stream: MarketEvent): void {
    if (stream.type === "book") {
      const tokenId = String(stream.payload.tokenId);
      if (!this.watched.has(tokenId)) return;

      const book = bookFromSnapshot(stream.payload.bids, stream.payload.asks);
      this.books.set(tokenId, book);
      this.pendingPriceChanges.delete(tokenId);
      this.updateMemory(
        tokenId,
        book,
        eventTimestampMs(stream.payload.timestamp),
      );
      return;
    }

    if (stream.type === "price_change") {
      const timestampMs = eventTimestampMs(stream.payload.timestamp);
      const changesByToken = new Map<
        string,
        Array<{
          side: OrderSide;
          price: string;
          size: string;
        }>
      >();

      for (const change of stream.payload.priceChanges) {
        const tokenId = String(change.tokenId);
        if (!this.watched.has(tokenId)) continue;

        const changes = changesByToken.get(tokenId) ?? [];
        changes.push({
          side: change.side,
          price: change.price,
          size: change.size,
        });
        changesByToken.set(tokenId, changes);
      }

      for (const [tokenId, changes] of changesByToken) {
        const book = this.books.get(tokenId);
        if (!book) {
          const pending = this.pendingPriceChanges.get(tokenId) ?? [];
          pending.push({ timestampMs, changes });
          this.pendingPriceChanges.set(tokenId, pending);
          continue;
        }

        const canonicalChanges = changes.map((change) =>
          applyPriceChange(book, change),
        );
        this.updateMemory(tokenId, book, timestampMs, canonicalChanges);
      }
      return;
    }

    if (stream.type === "market_resolved") {
      const nowMs = Date.now();
      const resolvedTokenIds: string[] = [];

      for (const tokenIdValue of stream.payload.assetIds ?? []) {
        const tokenId = String(tokenIdValue);
        const memory = this.ensureMemory(tokenId);
        memory?.clear();

        if (this.watched.delete(tokenId)) resolvedTokenIds.push(tokenId);

        this.completed.add(tokenId);
        this.books.delete(tokenId);
        this.pendingPriceChanges.delete(tokenId);
        this.seedRetryAfterMs.delete(tokenId);
        this.markDirty([tokenId]);
      }

      if (resolvedTokenIds.length > 0)
        this.subscriptions.remove(resolvedTokenIds);
    }
  }

  private async seedFromRest(tokenIds: readonly string[]): Promise<void> {
    const startedAt = performance.now();

    try {
      const snapshots = await this.snapshotClient.fetchOrderBooks(
        tokenIds.map((assetId) => ({ assetId })),
      );

      for (const snapshot of snapshots) {
        const tokenId = String(snapshot.assetId);
        if (
          !this.watched.has(tokenId) ||
          this.completed.has(tokenId) ||
          this.memories.has(tokenId)
        )
          continue;

        const snapshotMs = eventTimestampMs(snapshot.timestamp);
        const book = bookFromSnapshot(snapshot.bids, snapshot.asks);
        this.books.set(tokenId, book);
        this.updateMemory(tokenId, book, snapshotMs);

        const buffered = this.pendingPriceChanges.get(tokenId) ?? [];
        for (const event of buffered) {
          if (event.timestampMs <= snapshotMs) continue;
          const canonicalChanges = event.changes.map((change) =>
            applyPriceChange(book, change),
          );
          this.updateMemory(tokenId, book, event.timestampMs, canonicalChanges);
        }
        this.pendingPriceChanges.delete(tokenId);

        debugLog(
          "rest-seed",
          shortToken(tokenId),
          `buffered=${buffered.length}`,
          `historyLayers=${
            (this.memories.get(tokenId)?.historyDepth("bid") ?? 0) +
            (this.memories.get(tokenId)?.historyDepth("ask") ?? 0)
          }`,
        );
      }
    } catch (error) {
      const retryAt = Date.now() + REST_SEED_RETRY_MS;
      for (const tokenId of tokenIds)
        if (!this.memories.has(tokenId))
          this.seedRetryAfterMs.set(tokenId, retryAt);
      debugLog("rest-seed-error", tokenIds.map(shortToken), error);
    } finally {
      for (const tokenId of tokenIds) this.seedInFlight.delete(tokenId);
      debugLog(
        "rest-seed-batch",
        `requested=${tokenIds.length}`,
        `ms=${Math.round(performance.now() - startedAt)}`,
      );
    }
  }

  private updateMemory(
    tokenId: string,
    book: TokenBook,
    observedAtMs = Date.now(),
    changes?: readonly CanonicalBookChange[],
  ): void {
    const memory = this.ensureMemory(tokenId) ?? new PressureFrontierMemory();

    if (changes === undefined) {
      memory.observeBook(book, observedAtMs);
    } else {
      const bids: CanonicalBookChange[] = [];
      const asks: CanonicalBookChange[] = [];
      for (const change of changes) {
        const target = change.side === "bid" ? bids : asks;
        target.push(change);
      }
      if (bids.length > 0) memory.updateLevels("bid", bids, observedAtMs);
      if (asks.length > 0) memory.updateLevels("ask", asks, observedAtMs);
    }

    this.memories.set(tokenId, memory);

    if (!this.recordingSince.has(tokenId)) {
      this.recordingSince.set(tokenId, observedAtMs);
      debugLog(
        "first-snapshot",
        shortToken(tokenId),
        `priceBoundaries=${memory.priceBoundaries().length}`,
      );
    }

    this.markDirty([tokenId]);
  }

  private markDirty(tokenIds: Iterable<string>): void {
    for (const tokenId of tokenIds) this.dirtyTokens.add(tokenId);
    this.schedulePersist();
  }

  private schedulePersist(delayMs = PERSIST_DEBOUNCE_MS): void {
    if (
      this.dirtyTokens.size === 0 ||
      this.persistTimer !== undefined ||
      this.persistPromise !== null
    )
      return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistPromise = this.flushDirtyPass()
        .catch((error) => {
          console.error("Could not persist recorder state", error);
        })
        .finally(() => {
          this.persistPromise = null;
          if (this.dirtyTokens.size > 0) this.schedulePersist();
        });
    }, delayMs);
  }

  private async flushDirtyPass(): Promise<void> {
    if (this.dirtyTokens.size === 0) return;

    const startedAt = performance.now();
    const tokenIds = [...this.dirtyTokens];
    for (const tokenId of tokenIds) this.dirtyTokens.delete(tokenId);

    let written = 0;
    try {
      for (
        let offset = 0;
        offset < tokenIds.length;
        offset += PERSIST_BATCH_TOKENS
      ) {
        const batch = tokenIds.slice(offset, offset + PERSIST_BATCH_TOKENS);
        const savedAtMs = Date.now();

        this.store.write(
          batch.map((tokenId) => ({
            tokenId,
            status: this.completed.has(tokenId)
              ? ("completed" as const)
              : ("watched" as const),
            recordingSinceMs: this.recordingSince.get(tokenId) ?? null,
            pressure: this.ensureMemory(tokenId)?.snapshot() ?? null,
            savedAtMs,
          })),
        );
        written += batch.length;

        // bun:sqlite is synchronous. Keep transactions deliberately small and
        // yield between them so recorder HTTP/WebSocket traffic is never stuck
        // behind a multi-second checkpoint.
        if (offset + batch.length < tokenIds.length) await Bun.sleep(0);
      }
    } catch (error) {
      for (const tokenId of tokenIds.slice(written))
        this.dirtyTokens.add(tokenId);
      throw error;
    }

    debugLog(
      "sqlite-flush",
      `tokens=${tokenIds.length}`,
      `ms=${Math.round(performance.now() - startedAt)}`,
      `redirtied=${this.dirtyTokens.size}`,
    );
  }

  private restoreFromStore(): void {
    const startedAt = performance.now();

    for (const record of this.store.loadIndex()) {
      if (record.status === "completed") this.completed.add(record.tokenId);
      else this.watched.add(record.tokenId);

      if (record.recordingSinceMs !== null && record.hasPressure)
        this.recordingSince.set(record.tokenId, record.recordingSinceMs);
      if (record.hasPressure) this.storedPressureTokens.add(record.tokenId);
    }

    debugLog(
      "sqlite-index-load",
      `tokens=${this.watched.size + this.completed.size}`,
      `ms=${Math.round(performance.now() - startedAt)}`,
    );
  }

  private ensureMemory(tokenId: string): PressureFrontierMemory | undefined {
    const existing = this.memories.get(tokenId);
    if (existing || !this.storedPressureTokens.has(tokenId)) return existing;

    const startedAt = performance.now();
    const record = this.store.load(tokenId);
    if (!record || record.pressure === null) {
      this.storedPressureTokens.delete(tokenId);
      return undefined;
    }

    const memory = new PressureFrontierMemory();
    memory.restore(record.pressure);
    this.memories.set(tokenId, memory);
    this.storedPressureTokens.delete(tokenId);
    debugLog(
      "sqlite-hydrate",
      shortToken(tokenId),
      `ms=${Math.round(performance.now() - startedAt)}`,
    );
    return memory;
  }
}

function eventTimestampMs(value: unknown, fallbackMs = Date.now()): number {
  const timestamp = Number(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    timestamp > fallbackMs + 60_000
  )
    return fallbackMs;
  return timestamp;
}

function sqlitePathFor(legacyPath: string): string {
  return legacyPath.endsWith(".json")
    ? `${legacyPath.slice(0, -5)}.sqlite`
    : `${legacyPath}.sqlite`;
}

const recorder = new AgeRecorder();
await recorder.start();

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return response(null, 204);

    if (url.pathname === "/api/recorder/health")
      return response(recorder.stats());

    if (url.pathname === "/api/recorder/state" && request.method === "GET") {
      const tokenIds = parseTokenIds(url.searchParams);
      recorder.watch(tokenIds);
      recorder.seedPending(tokenIds);
      const includeStates = url.searchParams.get("metadataOnly") !== "1";
      const includeDebug =
        RECORDER_DEBUG || url.searchParams.get("debug") === "1";
      const body = recorder.state(tokenIds, includeStates, includeDebug);

      if (includeDebug)
        debugLog(
          "state",
          `requested=${tokenIds.length}`,
          `states=${Object.keys(body.states).length}`,
          `pending=${body.pendingTokenIds.length}`,
          `connected=${body.connected}`,
        );

      return response(body);
    }

    if (url.pathname === "/api/recorder/watch" && request.method === "POST") {
      const body = (await request.json()) as {
        tokenIds?: unknown;
      };
      const tokenIds = Array.isArray(body.tokenIds)
        ? body.tokenIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const changed = recorder.watch(tokenIds);
      return response({
        changed,
        ...recorder.stats(),
      });
    }

    return response({ error: "not found" }, 404);
  },
});

console.log(`Age recorder listening on http://127.0.0.1:${PORT}`);
console.log(`Persistent state: ${DATABASE_PATH} (SQLite/WAL)`);

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}; flushing recorder state…`);

  try {
    server.stop(false);
    await recorder.stop();
    process.exit(0);
  } catch (error) {
    console.error("Recorder shutdown flush failed", error);
    process.exit(1);
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

function debugLog(...args: unknown[]): void {
  if (RECORDER_DEBUG) console.log("[recorder]", ...args);
}

function shortToken(tokenId: string): string {
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

function parseTokenIds(params: URLSearchParams): string[] {
  return params
    .getAll("tokenId")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
