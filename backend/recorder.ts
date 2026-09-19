import { resolve } from "node:path";
import { createPublicClient, OrderSide } from "@polymarket/client";
import type { MarketEvent } from "@polymarket/client/actions";
import { RecorderStore } from "./recorderStore";
import { RecorderSubscriptionPool } from "./recorderSubscriptionPool";
import { HalfBook, type TokenBook } from "../src/lib/orderBook";
import {
  PressureMemory,
  type PressureCell,
} from "../src/lib/pressureMemory";
import { signedVolumeSegments } from "../src/lib/signedVolume";

const PORT = Number(process.env.RECORDER_PORT ?? 3001);
const LEGACY_STATE_PATH = resolve(
  process.env.RECORDER_STATE_PATH ??
    ".data/age-recorder.json",
);
const DATABASE_PATH = resolve(
  process.env.RECORDER_DB_PATH ??
    sqlitePathFor(LEGACY_STATE_PATH),
);
const PERSIST_DEBOUNCE_MS = 250;
const RECORDER_DEBUG = process.env.RECORDER_DEBUG === "1";

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
    subscriptionConnections: number;
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
          | {
              state:
                | "pending"
                | "subscribed"
                | "untracked";
              batchId?: number;
              connectionId?: number;
            }
          | undefined;
      }
    >;
  };
}

class AgeRecorder {
  private readonly store = new RecorderStore(
    DATABASE_PATH,
    (...args) => debugLog(...args),
  );
  private readonly watched = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly recordingSince = new Map<string, number>();
  private readonly books = new Map<string, TokenBook<string>>();
  private readonly memories = new Map<string, PressureMemory>();
  private readonly dirtyTokens = new Set<string>();
  private readonly subscriptions = new RecorderSubscriptionPool(
    () => createPublicClient(),
    (event) => this.consumeEvent(event),
    (...args) => debugLog(...args),
  );
  private persistTimer:
    | ReturnType<typeof setTimeout>
    | undefined;

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

    this.flushDirty();
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
      .map((tokenId) =>
        this.recordingSince.get(tokenId),
      )
      .filter(
        (value): value is number =>
          value !== undefined,
      );
    const recordingSinceMs =
      requested.length > 0 &&
      coverageStarts.length === requested.length
        ? Math.max(...coverageStarts)
        : null;

    const recordingSinceMsByToken =
      Object.fromEntries(
        requested.flatMap((tokenId) => {
          const since =
            this.recordingSince.get(tokenId);
          return since === undefined
            ? []
            : [[tokenId, since] as const];
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
      const subscription =
        this.subscriptions.debugStatus(requested);
      result.debug = {
        subscriptionConnections:
          this.subscriptions.activeConnectionCount,
        subscriptionBatches:
          this.subscriptions.activeBatchCount,
        tokens: Object.fromEntries(
          requested.map((tokenId) => {
            const memory =
              this.memories.get(tokenId);
            return [
              tokenId,
              {
                watched:
                  this.watched.has(tokenId),
                completed:
                  this.completed.has(tokenId),
                hasBook:
                  this.books.has(tokenId),
                hasMemory: memory !== undefined,
                memoryCells:
                  memory?.snapshot().length ?? 0,
                recordingSinceMs:
                  this.recordingSince.get(
                    tokenId,
                  ) ?? null,
                subscription:
                  subscription[tokenId],
              },
            ];
          }),
        ),
      };
    }

    return result;
  }

  stats() {
    const starts = [
      ...this.recordingSince.values(),
    ];
    return {
      watchedTokens: this.watched.size,
      completedTokens: this.completed.size,
      hydratedTokens: this.memories.size,
      liveBooks: this.books.size,
      connected: this.subscriptions.connected,
      subscriptionConnections:
        this.subscriptions.activeConnectionCount,
      subscriptionBatches:
        this.subscriptions.activeBatchCount,
      dirtyTokens: this.dirtyTokens.size,
      oldestRecordingSinceMs: starts.length
        ? Math.min(...starts)
        : null,
      newestRecordingSinceMs: starts.length
        ? Math.max(...starts)
        : null,
      databasePath: DATABASE_PATH,
    };
  }

  private consumeEvent(stream: MarketEvent): void {
    if (stream.type === "book") {
      const tokenId = String(
        stream.payload.tokenId,
      );
      if (!this.watched.has(tokenId)) return;

      const book = bookFromSnapshot(
        stream.payload,
      );
      this.books.set(tokenId, book);
      this.updateMemory(tokenId, book);
      return;
    }

    if (stream.type === "price_change") {
      const touched = new Set<string>();
      for (const change of stream.payload.priceChanges) {
        const tokenId = String(
          change.tokenId,
        );
        if (!this.watched.has(tokenId)) continue;

        const book = this.books.get(tokenId);
        if (!book) continue;

        applyPriceChange(book, change);
        touched.add(tokenId);
      }

      for (const tokenId of touched) {
        const book = this.books.get(tokenId);
        if (book)
          this.updateMemory(tokenId, book);
      }
      return;
    }

    if (stream.type === "market_resolved") {
      const nowMs = Date.now();
      const resolvedTokenIds: string[] = [];

      for (
        const tokenIdValue of
        stream.payload.assetIds ?? []
      ) {
        const tokenId = String(tokenIdValue);
        const memory =
          this.memories.get(tokenId);
        memory?.observe(
          [{ lo: 0, hi: 1, volume: 0 }],
          nowMs,
        );

        if (this.watched.delete(tokenId))
          resolvedTokenIds.push(tokenId);

        this.completed.add(tokenId);
        this.books.delete(tokenId);
        this.markDirty([tokenId]);
      }

      if (resolvedTokenIds.length > 0)
        this.subscriptions.remove(
          resolvedTokenIds,
        );
    }
  }

  private updateMemory(
    tokenId: string,
    book: TokenBook<string>,
  ): void {
    const nowMs = Date.now();
    const memory =
      this.memories.get(tokenId) ??
      new PressureMemory();
    memory.observe(
      signedVolumeSegments(book),
      nowMs,
    );
    this.memories.set(tokenId, memory);

    if (!this.recordingSince.has(tokenId)) {
      this.recordingSince.set(
        tokenId,
        nowMs,
      );
      debugLog(
        "first-snapshot",
        shortToken(tokenId),
        `cells=${memory.snapshot().length}`,
      );
    }

    this.markDirty([tokenId]);
  }

  private markDirty(
    tokenIds: Iterable<string>,
  ): void {
    for (const tokenId of tokenIds)
      this.dirtyTokens.add(tokenId);

    if (
      this.dirtyTokens.size === 0 ||
      this.persistTimer !== undefined
    )
      return;

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      try {
        this.flushDirty();
      } catch (error) {
        console.error(
          "Could not persist recorder state",
          error,
        );
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  private flushDirty(): void {
    if (this.dirtyTokens.size === 0) return;

    const tokenIds = [
      ...this.dirtyTokens,
    ];
    this.dirtyTokens.clear();
    const savedAtMs = Date.now();

    try {
      this.store.write(
        tokenIds.map((tokenId) => ({
          tokenId,
          status: this.completed.has(tokenId)
            ? ("completed" as const)
            : ("watched" as const),
          recordingSinceMs:
            this.recordingSince.get(tokenId) ??
            null,
          cells:
            this.memories
              .get(tokenId)
              ?.snapshot() ?? null,
          savedAtMs,
        })),
      );
    } catch (error) {
      for (const tokenId of tokenIds)
        this.dirtyTokens.add(tokenId);
      throw error;
    }

    debugLog(
      "sqlite-flush",
      `tokens=${tokenIds.length}`,
    );
  }

  private restoreFromStore(): void {
    const startedAt = performance.now();

    for (const record of this.store.loadAll()) {
      if (record.status === "completed")
        this.completed.add(record.tokenId);
      else
        this.watched.add(record.tokenId);

      if (record.recordingSinceMs !== null)
        this.recordingSince.set(
          record.tokenId,
          record.recordingSinceMs,
        );

      if (record.cells !== null) {
        const memory = new PressureMemory();
        memory.restore(record.cells);
        this.memories.set(
          record.tokenId,
          memory,
        );
      }
    }

    debugLog(
      "sqlite-load",
      `tokens=${
        this.watched.size +
        this.completed.size
      }`,
      `ms=${Math.round(
        performance.now() - startedAt,
      )}`,
    );
  }
}

function sqlitePathFor(
  legacyPath: string,
): string {
  return legacyPath.endsWith(".json")
    ? `${legacyPath.slice(0, -5)}.sqlite`
    : `${legacyPath}.sqlite`;
}

function bookFromSnapshot(payload: {
  bids: readonly {
    price: string;
    size: string;
  }[];
  asks: readonly {
    price: string;
    size: string;
  }[];
}): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  for (const bid of payload.bids) {
    const price = Number(bid.price);
    usdToYes.setLevel(bid.price, {
      price,
      take: Number(bid.size),
    });
  }

  const yesToUsd = new HalfBook<string>();
  for (const ask of payload.asks) {
    const canonicalAsk = Number(ask.price);
    yesToUsd.setLevel(ask.price, {
      price: 1 / canonicalAsk,
      take:
        Number(ask.size) * canonicalAsk,
    });
  }

  // Synthetic Polymarket mint route; never
  // contributes inside [0, 1).
  yesToUsd.setLevel("mint", {
    price: 1,
    take: Infinity,
  });
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
    book.usdToYes.setLevel(
      change.price,
      { price, take: size },
    );
  } else {
    book.yesToUsd.setLevel(
      change.price,
      {
        price: 1 / price,
        take: size * price,
      },
    );
  }
}

const recorder = new AgeRecorder();
await recorder.start();

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return response(null, 204);

    if (
      url.pathname ===
      "/api/recorder/health"
    )
      return response(recorder.stats());

    if (
      url.pathname ===
        "/api/recorder/state" &&
      request.method === "GET"
    ) {
      const tokenIds = parseTokenIds(
        url.searchParams,
      );
      recorder.watch(tokenIds);
      const includeStates =
        url.searchParams.get(
          "metadataOnly",
        ) !== "1";
      const includeDebug =
        RECORDER_DEBUG ||
        url.searchParams.get("debug") ===
          "1";
      const body = recorder.state(
        tokenIds,
        includeStates,
        includeDebug,
      );

      if (includeDebug)
        debugLog(
          "state",
          `requested=${tokenIds.length}`,
          `states=${
            Object.keys(body.states).length
          }`,
          `pending=${
            body.pendingTokenIds.length
          }`,
          `connected=${body.connected}`,
        );

      return response(body);
    }

    if (
      url.pathname ===
        "/api/recorder/watch" &&
      request.method === "POST"
    ) {
      const body =
        (await request.json()) as {
          tokenIds?: unknown;
        };
      const tokenIds = Array.isArray(
        body.tokenIds,
      )
        ? body.tokenIds.filter(
            (
              value,
            ): value is string =>
              typeof value === "string",
          )
        : [];
      const changed =
        recorder.watch(tokenIds);
      return response({
        changed,
        ...recorder.stats(),
      });
    }

    return response(
      { error: "not found" },
      404,
    );
  },
});

console.log(
  `Age recorder listening on http://127.0.0.1:${PORT}`,
);
console.log(
  `Persistent state: ${DATABASE_PATH} (SQLite/WAL)`,
);

let shuttingDown = false;
const shutdown = async (
  signal: NodeJS.Signals,
) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    `Received ${signal}; flushing recorder state…`,
  );

  try {
    server.stop(false);
    await recorder.stop();
    process.exit(0);
  } catch (error) {
    console.error(
      "Recorder shutdown flush failed",
      error,
    );
    process.exit(1);
  }
};

process.once(
  "SIGINT",
  () => void shutdown("SIGINT"),
);
process.once(
  "SIGTERM",
  () => void shutdown("SIGTERM"),
);

function debugLog(
  ...args: unknown[]
): void {
  if (RECORDER_DEBUG)
    console.log("[recorder]", ...args);
}

function shortToken(
  tokenId: string,
): string {
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(
        0,
        6,
      )}…${tokenId.slice(-4)}`;
}

function parseTokenIds(
  params: URLSearchParams,
): string[] {
  return params
    .getAll("tokenId")
    .flatMap((value) =>
      value.split(","),
    )
    .map((value) => value.trim())
    .filter(Boolean);
}

function response(
  body: unknown,
  status = 200,
): Response {
  return new Response(
    body === null
      ? null
      : JSON.stringify(body),
    {
      status,
      headers: {
        "content-type":
          "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-methods":
          "GET,POST,OPTIONS",
        "access-control-allow-headers":
          "content-type",
      },
    },
  );
}
