import { resolve } from "node:path";
import { createPublicClient, OrderSide } from "@polymarket/client";
import type { MarketEvent } from "@polymarket/client/actions";
import { DirtyTokenTracker } from "./dirtyTokenTracker";
import type { RecorderPressureMutation } from "./recorderPressureLog";
import { RecorderStore } from "./recorderStore";
import { RecorderSubscriptionPool } from "./recorderSubscriptionPool";
import {
  applyPriceChange,
  bookFromSnapshot,
  type CanonicalBookChange,
} from "../src/lib/bookIngestion";
import type { TokenBook } from "../src/lib/orderBook";
import {
  tokenPressureChanges,
  tokenPressureLevels,
} from "../src/lib/pressureBookAdapter";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import type { PressureFrontierSnapshot } from "../src/lib/pressureFrontierSnapshot";

const PORT = Number(process.env.RECORDER_PORT ?? 3001);
const DATABASE_PATH = resolve(
  process.env.RECORDER_DB_PATH ?? ".data/age-recorder.sqlite",
);
const PERSIST_DEBOUNCE_MS = Number(process.env.RECORDER_PERSIST_MS ?? 1_000);
const PERSIST_BATCH_TOKENS = Number(
  process.env.RECORDER_PERSIST_BATCH_TOKENS ?? 8,
);
const REST_SEED_BATCH_TOKENS = 20;
const REST_SEED_RETRY_MS = 5_000;
const RECORDER_DEBUG = process.env.RECORDER_DEBUG === "1";
const BYTES_PER_KIB = 1024;

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
  private readonly store = new RecorderStore(DATABASE_PATH);
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
  private readonly pendingPressureMutations = new Map<
    string,
    RecorderPressureMutation[]
  >();
  private readonly seedInFlight = new Set<string>();
  private readonly seedRetryAfterMs = new Map<string, number>();
  private readonly dirtyTokens = new DirtyTokenTracker();
  private readonly subscriptions = new RecorderSubscriptionPool(
    () => createPublicClient(),
    (event) => this.consumeEvent(event),
    (...args) => debugLog(...args),
  );
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistPromise: Promise<void> | null = null;

  async start(): Promise<void> {
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
            return [
              tokenId,
              {
                watched: this.watched.has(tokenId),
                completed: this.completed.has(tokenId),
                hasBook: this.books.has(tokenId),
                hasMemory: this.memories.has(tokenId),
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
      subscriptionConnections: this.subscriptions.activeConnectionCount,
      subscriptionBatches: this.subscriptions.activeBatchCount,
      dirtyTokens: this.dirtyTokens.size,
      pendingPressureMutations: [
        ...this.pendingPressureMutations.values(),
      ].reduce((sum, mutations) => sum + mutations.length, 0),
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
      const resolvedTokenIds: string[] = [];

      for (const tokenIdValue of stream.payload.assetIds ?? []) {
        const tokenId = String(tokenIdValue);
        const memory = this.ensureMemory(tokenId);
        if (memory) {
          memory.clear();
          this.queuePressureMutation(tokenId, { kind: "clear" });
        }

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
    validThroughMs = Date.now(),
    changes?: readonly CanonicalBookChange[],
  ): void {
    const memory = this.ensureMemory(tokenId) ?? new PressureFrontierMemory();

    let mutation: RecorderPressureMutation;
    let mutated: boolean;
    if (changes === undefined) {
      const levels = tokenPressureLevels(book);
      mutated = memory.observeLevels(levels, validThroughMs);
      mutation = { kind: "replace", validThroughMs, levels };
    } else {
      const pressureChanges = tokenPressureChanges(changes);
      mutated = memory.updateLevels(pressureChanges, validThroughMs);
      mutation = { kind: "update", validThroughMs, changes: pressureChanges };
    }
    if (!mutated) return;

    this.memories.set(tokenId, memory);
    this.queuePressureMutation(tokenId, mutation);

    if (!this.recordingSince.has(tokenId)) {
      this.recordingSince.set(tokenId, validThroughMs);
      debugLog(
        "first-snapshot",
        shortToken(tokenId),
        `priceBoundaries=${memory.priceBoundaries().length}`,
      );
    }

    this.markDirty([tokenId]);
  }

  private queuePressureMutation(
    tokenId: string,
    mutation: RecorderPressureMutation,
  ): void {
    const pending = this.pendingPressureMutations.get(tokenId) ?? [];
    pending.push(mutation);
    this.pendingPressureMutations.set(tokenId, pending);
  }

  private markDirty(tokenIds: Iterable<string>): void {
    this.dirtyTokens.mark(tokenIds);
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
    const tokenIds = this.dirtyTokens.tokenIds();
    let encodeMs = 0;
    let sqliteMs = 0;
    let mutationCount = 0;
    let mutationBytes = 0;
    let checkpointCount = 0;
    let checkpointBytes = 0;

    for (
      let offset = 0;
      offset < tokenIds.length;
      offset += PERSIST_BATCH_TOKENS
    ) {
      const batch = tokenIds.slice(offset, offset + PERSIST_BATCH_TOKENS);
      const versions = this.dirtyTokens.capture(batch);
      if (versions.length === 0) continue;

      const writes = versions.map(({ tokenId }) => {
        const mutations = this.pendingPressureMutations.get(tokenId) ?? [];
        const shouldCheckpoint =
          this.completed.has(tokenId) ||
          this.store.shouldCheckpoint(tokenId, mutations.length);

        return {
          tokenId,
          status: this.completed.has(tokenId)
            ? ("completed" as const)
            : ("watched" as const),
          recordingSinceMs: this.recordingSince.get(tokenId) ?? null,
          mutations,
          checkpoint: shouldCheckpoint
            ? (this.ensureMemory(tokenId)?.snapshot() ?? null)
            : undefined,
        };
      });

      const stats = this.store.write(writes);
      encodeMs += stats.encodeMs;
      sqliteMs += stats.sqliteMs;
      mutationCount += stats.mutationCount;
      mutationBytes += stats.mutationBytes;
      checkpointCount += stats.checkpointCount;
      checkpointBytes += stats.checkpointBytes;

      for (const { tokenId } of versions)
        this.pendingPressureMutations.delete(tokenId);
      this.dirtyTokens.acknowledge(versions);

      // bun:sqlite is synchronous. Keep transactions deliberately small and
      // yield between them so recorder HTTP/WebSocket traffic is never stuck
      // behind a checkpoint.
      if (offset + batch.length < tokenIds.length) await Bun.sleep(0);
    }

    debugLog(
      "sqlite-flush",
      `tokens=${tokenIds.length}`,
      `ms=${Math.round(performance.now() - startedAt)}`,
      `encodeMs=${Math.round(encodeMs)}`,
      `sqliteMs=${Math.round(sqliteMs)}`,
      `ops=${mutationCount}`,
      `opKiB=${Math.round(mutationBytes / BYTES_PER_KIB)}`,
      `checkpoints=${checkpointCount}`,
      `checkpointKiB=${Math.round(checkpointBytes / BYTES_PER_KIB)}`,
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
      this.recordingSince.delete(tokenId);
      this.markDirty([tokenId]);
      debugLog("discard-incompatible-pressure", shortToken(tokenId));
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
