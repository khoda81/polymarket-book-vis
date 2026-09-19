import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPublicClient, OrderSide } from "@polymarket/client";
import type { MarketEvent } from "@polymarket/client/actions";
import { RecorderSubscriptionPool } from "./recorderSubscriptionPool";
import { HalfBook, type TokenBook } from "../src/lib/orderBook";
import {
  PressureMemory,
  parsePressureCells,
  type PressureCell,
} from "../src/lib/pressureMemory";
import { signedVolumeSegments } from "../src/lib/signedVolume";
import {
  StaleSignedVolume,
  type StaleSignedVolumeSnapshot,
} from "../src/lib/staleSignedVolume";

const PORT = Number(process.env.RECORDER_PORT ?? 3001);
const STATE_PATH = resolve(
  process.env.RECORDER_STATE_PATH ?? ".data/age-recorder.json",
);
const PERSIST_DEBOUNCE_MS = 250;
const MAX_CLOCK_SKEW_MS = 60_000;
const RECORDER_DEBUG = process.env.RECORDER_DEBUG === "1";

interface PersistedRecorderStateV2 {
  version: 2;
  savedAtMs: number;
  watchedTokenIds: string[];
  completedTokenIds: string[];
  /** Earliest known recorder coverage start for each token. */
  recordingSinceMs: Record<string, number>;
  states: Record<string, readonly PressureCell[]>;
}

interface PersistedRecorderStateV1 {
  version: 1;
  watchedTokenIds: string[];
  recordingSinceMs?: Record<string, number>;
  states: Record<string, StaleSignedVolumeSnapshot>;
}

type PersistedRecorderState =
  | PersistedRecorderStateV2
  | PersistedRecorderStateV1;

interface TransportState {
  cells: readonly PressureCell[];
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
    subscriptionBatches: number;
    tokens: Record<
      string,
      {
        watched: boolean;
        completed: boolean;
        hasBook: boolean;
        hasMemory: boolean;
        memoryCells: number;
        recordingSinceMs: number | null;
        subscription:
          | { state: "pending" | "subscribed" | "untracked"; batchId?: number }
          | undefined;
      }
    >;
  };
}

class AgeRecorder {
  private readonly client = createPublicClient();
  private readonly watched = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly recordingSince = new Map<string, number>();
  private readonly books = new Map<string, TokenBook<string>>();
  private readonly memories = new Map<string, PressureMemory>();
  private readonly subscriptions = new RecorderSubscriptionPool(
    this.client,
    (event) => this.consumeEvent(event),
  );
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistDirty = false;
  private persistenceBlocked = false;
  private persistChain: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    await this.restoreFromDisk();
    this.subscriptions.add(this.watched);
  }

  async stop(): Promise<void> {
    const startedAt = performance.now();

    // Socket close handshakes are not part of persistence correctness and can
    // stall indefinitely. Stop consuming immediately and let process exit
    // reclaim the transports after the checkpoint is durable.
    this.subscriptions.stop();

    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persistenceBlocked)
      throw new Error(
        "Recorder persistence is blocked because corrupt state could not be preserved",
      );
    if (this.persistDirty) this.enqueuePersist();
    await this.persistChain;

    // The normal checkpoint chain logs failures and stays recoverable. Shutdown
    // is different: make one final direct retry and propagate failure so the
    // process cannot report a clean exit after losing the last checkpoint.
    if (this.persistDirty) {
      this.persistDirty = false;
      await this.persistSnapshot();
    }

    console.log(
      `Recorder state flushed in ${Math.round(performance.now() - startedAt)}ms`,
    );
  }

  watch(tokenIds: Iterable<string>): boolean {
    const added: string[] = [];
    for (const tokenId of tokenIds) {
      if (
        !tokenId ||
        this.watched.has(tokenId) ||
        this.completed.has(tokenId)
      )
        continue;
      this.watched.add(tokenId);
      added.push(tokenId);
    }
    if (added.length === 0) return false;

    this.schedulePersist();
    this.subscriptions.add(added);
    debugLog(
      "watch",
      added.map(shortToken),
      `watched=${this.watched.size}`,
      `batches=${this.subscriptions.activeBatchCount}`,
    );
    return true;
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
        const memory = this.memories.get(tokenId);
        if (!memory) continue;
        states[tokenId] = {
          cells: memory.snapshot(),
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
        !this.memories.has(tokenId),
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
                memoryCells: memory?.snapshot().length ?? 0,
                recordingSinceMs:
                  this.recordingSince.get(tokenId) ?? null,
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
      subscriptionBatches: this.subscriptions.activeBatchCount,
      oldestRecordingSinceMs: starts.length ? Math.min(...starts) : null,
      newestRecordingSinceMs: starts.length ? Math.max(...starts) : null,
      statePath: STATE_PATH,
    };
  }

  private consumeEvent(stream: MarketEvent): void {
    if (stream.type === "book") {
      const tokenId = String(stream.payload.tokenId);
      if (!this.watched.has(tokenId)) return;

      const book = bookFromSnapshot(stream.payload);
      this.books.set(tokenId, book);
      this.updateMemory(tokenId, book);
      return;
    }

    if (stream.type === "price_change") {
      const touched = new Set<string>();
      for (const change of stream.payload.priceChanges) {
        const tokenId = String(change.tokenId);
        if (!this.watched.has(tokenId)) continue;

        const book = this.books.get(tokenId);
        if (!book) continue;

        applyPriceChange(book, change);
        touched.add(tokenId);
      }

      for (const tokenId of touched) {
        const book = this.books.get(tokenId);
        if (book) this.updateMemory(tokenId, book);
      }
      return;
    }

    if (stream.type === "market_resolved") {
      const nowMs = Date.now();
      const resolvedTokenIds: string[] = [];
      let changed = false;

      for (const tokenIdValue of stream.payload.assetIds ?? []) {
        const tokenId = String(tokenIdValue);
        const memory = this.memories.get(tokenId);
        memory?.observe(
          [{ lo: 0, hi: 1, volume: 0 }],
          nowMs,
        );

        if (this.watched.delete(tokenId)) {
          resolvedTokenIds.push(tokenId);
          changed = true;
        }
        this.completed.add(tokenId);
        this.books.delete(tokenId);
      }

      if (resolvedTokenIds.length > 0)
        this.subscriptions.remove(resolvedTokenIds);
      if (changed) this.schedulePersist();
    }
  }

  private updateMemory(
    tokenId: string,
    book: TokenBook<string>,
  ): void {
    const nowMs = Date.now();
    const memory = this.memories.get(tokenId) ?? new PressureMemory();
    memory.observe(signedVolumeSegments(book), nowMs);
    this.memories.set(tokenId, memory);

    // Coverage begins at the first authoritative websocket snapshot/update we
    // actually observed, not when the browser merely asked us to watch it.
    if (!this.recordingSince.has(tokenId)) {
      this.recordingSince.set(tokenId, nowMs);
      debugLog(
        "first-snapshot",
        shortToken(tokenId),
        `cells=${memory.snapshot().length}`,
      );
    }

    this.schedulePersist();
  }

  private schedulePersist(): void {
    this.persistDirty = true;
    if (this.persistenceBlocked) return;
    // Bounded checkpoint latency: once armed, later updates do not postpone
    // this write. Updates arriving while a write is in flight arm the next
    // checkpoint independently.
    if (this.persistTimer !== undefined) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.enqueuePersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private enqueuePersist(): void {
    if (!this.persistDirty || this.persistenceBlocked) return;
    this.persistDirty = false;

    const write = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistSnapshot());
    this.persistChain = write.catch((error) => {
      // Keep the serialization chain usable after a failed checkpoint. Mark
      // the state dirty again so a later update or shutdown retries it.
      this.persistDirty = true;
      console.error("Could not persist recorder state", error);
    });
  }

  private async persistSnapshot(): Promise<void> {
    const savedAtMs = Date.now();
    const states: Record<string, readonly PressureCell[]> = {};
    for (const [tokenId, memory] of this.memories)
      states[tokenId] = memory.snapshot();

    const payload: PersistedRecorderStateV2 = {
      version: 2,
      savedAtMs,
      watchedTokenIds: [...this.watched],
      completedTokenIds: [...this.completed],
      recordingSinceMs: Object.fromEntries(this.recordingSince),
      states,
    };

    await mkdir(dirname(STATE_PATH), { recursive: true });
    const temporary = `${STATE_PATH}.tmp`;
    await writeFile(temporary, JSON.stringify(payload), "utf8");
    await rename(temporary, STATE_PATH);
  }

  private async restoreFromDisk(): Promise<void> {
    let parsed: PersistedRecorderState;
    try {
      const raw = JSON.parse(await readFile(STATE_PATH, "utf8")) as unknown;
      parsed = parsePersistedRecorderState(raw);
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      await this.quarantineUnreadableState(error);
      return;
    }

    const migrationNowMs = Date.now();
    const restoredWatched = new Set<string>();
    const restoredCompleted = new Set<string>();
    const restoredRecordingSince = new Map<string, number>();
    const restoredMemories = new Map<string, PressureMemory>();
    let migrated = parsed.version === 1;

    try {
      for (const tokenId of parsed.watchedTokenIds)
        if (tokenId) restoredWatched.add(tokenId);

      if (parsed.version === 2) {
        for (const tokenId of parsed.completedTokenIds) {
          if (!tokenId) continue;
          restoredCompleted.add(tokenId);
          restoredWatched.delete(tokenId);
        }

        for (const [tokenId, value] of Object.entries(
          parsed.recordingSinceMs,
        )) {
          const since = validWallClockMs(value, migrationNowMs);
          if (since !== undefined)
            restoredRecordingSince.set(tokenId, since);
        }

        for (const [tokenId, rawCells] of Object.entries(parsed.states)) {
          const cells = parsePressureCells(rawCells).map((cell) => ({
            ...cell,
            bands: cell.bands.map((band) => ({
              ...band,
              state:
                band.state.kind === "live"
                  ? {
                      kind: "ghost" as const,
                      sinceMs: Math.min(
                        parsed.savedAtMs,
                        migrationNowMs,
                      ),
                    }
                  : band.state,
            })),
          }));
          const memory = new PressureMemory();
          memory.restore(cells);
          restoredMemories.set(tokenId, memory);
        }
      } else {
        for (const tokenId of parsed.watchedTokenIds) {
          const storedStart = validWallClockMs(
            parsed.recordingSinceMs?.[tokenId],
            migrationNowMs,
          );
          const inferredStart = earliestSnapshotObservationMs(
            parsed.states[tokenId],
            migrationNowMs,
          );
          const knownStarts = [storedStart, inferredStart].filter(
            (value): value is number => value !== undefined,
          );
          restoredRecordingSince.set(
            tokenId,
            knownStarts.length
              ? Math.min(...knownStarts)
              : migrationNowMs,
          );
        }

        for (const [tokenId, snapshot] of Object.entries(parsed.states)) {
          const legacy = new StaleSignedVolume();
          legacy.restore(snapshot);
          const memory = new PressureMemory();
          memory.restore(
            legacy.segments(migrationNowMs).map((segment) => ({
              lo: segment.lo,
              hi: segment.hi,
              bands:
                segment.volume === 0
                  ? []
                  : [
                      {
                        loVolume: 0,
                        hiVolume: Math.abs(segment.volume),
                        side: segment.volume < 0 ? (-1 as const) : (1 as const),
                        state: {
                          kind: "ghost" as const,
                          sinceMs:
                            segment.ageMs === Infinity
                              ? migrationNowMs
                              : migrationNowMs - segment.ageMs,
                        },
                      },
                    ],
            })),
          );
          restoredMemories.set(tokenId, memory);
        }
      }
    } catch (error) {
      await this.quarantineUnreadableState(error);
      return;
    }

    this.watched.clear();
    for (const tokenId of restoredWatched) this.watched.add(tokenId);
    this.completed.clear();
    for (const tokenId of restoredCompleted) this.completed.add(tokenId);
    this.recordingSince.clear();
    for (const [tokenId, since] of restoredRecordingSince)
      this.recordingSince.set(tokenId, since);
    this.memories.clear();
    for (const [tokenId, memory] of restoredMemories)
      this.memories.set(tokenId, memory);

    if (migrated) {
      await this.backupLegacyState();
      this.schedulePersist();
    }
  }

  private async backupLegacyState(): Promise<void> {
    const backup = `${STATE_PATH}.v1-backup-${Date.now()}`;
    try {
      await copyFile(STATE_PATH, backup);
      console.log(
        `Preserved v1 recorder state before migration: ${backup}`,
      );
    } catch (error) {
      this.persistenceBlocked = true;
      throw new Error(
        `Could not preserve v1 recorder state before migration to v2: ${String(error)}`,
      );
    }
  }

  private async quarantineUnreadableState(error: unknown): Promise<void> {
    console.warn("Recorder state is invalid; preserving it before continuing", error);
    const backup = `${STATE_PATH}.corrupt-${Date.now()}`;
    try {
      await rename(STATE_PATH, backup);
      console.warn(`Moved invalid recorder state to ${backup}`);
    } catch (renameError) {
      this.persistenceBlocked = true;
      console.error(
        "Could not preserve invalid recorder state; persistence is blocked",
        renameError,
      );
    }
  }
}

function parsePersistedRecorderState(
  value: unknown,
): PersistedRecorderState {
  if (!isRecord(value))
    throw new TypeError("Malformed recorder state");

  if (value.version === 2) {
    if (!Array.isArray(value.watchedTokenIds))
      throw new TypeError("Recorder watchedTokenIds must be an array");
    if (!Array.isArray(value.completedTokenIds))
      throw new TypeError("Recorder completedTokenIds must be an array");
    if (!isRecord(value.states))
      throw new TypeError("Recorder states must be an object");
    if (!isRecord(value.recordingSinceMs))
      throw new TypeError("Recorder recordingSinceMs must be an object");
    if (typeof value.savedAtMs !== "number" || !Number.isFinite(value.savedAtMs))
      throw new TypeError("Recorder savedAtMs must be finite");

    return {
      version: 2,
      savedAtMs: value.savedAtMs,
      watchedTokenIds: stringArray(
        value.watchedTokenIds,
        "watched token ids",
      ),
      completedTokenIds: stringArray(
        value.completedTokenIds,
        "completed token ids",
      ),
      recordingSinceMs:
        value.recordingSinceMs as Record<string, number>,
      states: value.states as Record<string, readonly PressureCell[]>,
    };
  }

  if (value.version === 1) {
    if (!Array.isArray(value.watchedTokenIds))
      throw new TypeError("Recorder watchedTokenIds must be an array");
    if (!isRecord(value.states))
      throw new TypeError("Recorder states must be an object");
    if (
      value.recordingSinceMs !== undefined &&
      !isRecord(value.recordingSinceMs)
    )
      throw new TypeError("Recorder recordingSinceMs must be an object");

    return {
      version: 1,
      watchedTokenIds: stringArray(
        value.watchedTokenIds,
        "watched token ids",
      ),
      recordingSinceMs:
        value.recordingSinceMs as Record<string, number> | undefined,
      states: value.states as Record<string, StaleSignedVolumeSnapshot>,
    };
  }

  throw new TypeError("Unsupported recorder state version");
}

function stringArray(value: unknown[], label: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string")
      throw new TypeError(`Recorder ${label} must be strings`);
    return item;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function earliestSnapshotObservationMs(
  snapshot: StaleSignedVolumeSnapshot | undefined,
  nowMs: number,
): number | undefined {
  if (!snapshot) return undefined;

  let earliest: number | undefined;
  for (const segment of snapshot.segments ?? []) {
    const observedAt = validWallClockMs(
      segment.observedAtMs ?? segment.staleSinceMs,
      nowMs,
    );
    if (observedAt === undefined) continue;
    earliest = earliest === undefined ? observedAt : Math.min(earliest, observedAt);
  }

  // lastUpdateMs is weaker evidence than an actual held observation, but it is
  // still a truthful lower bound when a snapshot contains only unknown ranges.
  return earliest ?? validWallClockMs(snapshot.lastUpdateMs, nowMs);
}

function validWallClockMs(value: unknown, nowMs: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= nowMs + MAX_CLOCK_SKEW_MS
    ? value
    : undefined;
}

function bookFromSnapshot(payload: {
  bids: readonly { price: string; size: string }[];
  asks: readonly { price: string; size: string }[];
}): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  for (const bid of payload.bids) {
    const price = Number(bid.price);
    usdToYes.setLevel(bid.price, { price, take: Number(bid.size) });
  }

  const yesToUsd = new HalfBook<string>();
  for (const ask of payload.asks) {
    const canonicalAsk = Number(ask.price);
    yesToUsd.setLevel(ask.price, {
      price: 1 / canonicalAsk,
      take: Number(ask.size) * canonicalAsk,
    });
  }
  // Synthetic Polymarket mint route; never contributes inside [0, 1).
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });
  return { usdToYes, yesToUsd };
}

function applyPriceChange(
  book: TokenBook<string>,
  change: {
    side: OrderSide;
    price: string;
    size: string;
  },
): void {
  const price = Number(change.price);
  const size = Number(change.size);
  if (change.side === OrderSide.BUY) {
    book.usdToYes.setLevel(change.price, { price, take: size });
  } else {
    book.yesToUsd.setLevel(change.price, {
      price: 1 / price,
      take: size * price,
    });
  }
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
      const body = (await request.json()) as { tokenIds?: unknown };
      const tokenIds = Array.isArray(body.tokenIds)
        ? body.tokenIds.filter((value): value is string => typeof value === "string")
        : [];
      const changed = recorder.watch(tokenIds);
      return response({ changed, ...recorder.stats() });
    }

    return response({ error: "not found" }, 404);
  },
});

console.log(`Age recorder listening on http://127.0.0.1:${PORT}`);
console.log(`Persistent state: ${STATE_PATH}`);

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
