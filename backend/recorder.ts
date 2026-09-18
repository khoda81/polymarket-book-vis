import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPublicClient, OrderSide, TransportError } from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";
import { HalfBook, type TokenBook } from "../src/lib/orderBook";
import {
  StaleSignedVolume,
  type PressureObservationRange,
  type StaleSignedVolumeSnapshot,
} from "../src/lib/staleSignedVolume";

const PORT = Number(process.env.RECORDER_PORT ?? 3001);
const STATE_PATH = resolve(
  process.env.RECORDER_STATE_PATH ?? ".data/age-recorder.json",
);
const PERSIST_DEBOUNCE_MS = 250;
const MAX_CLOCK_SKEW_MS = 60_000;

interface PersistedRecorderState {
  version: 1;
  watchedTokenIds: string[];
  /** Earliest known recorder coverage start for each token. */
  recordingSinceMs?: Record<string, number>;
  states: Record<string, StaleSignedVolumeSnapshot>;
}

interface TransportSegment {
  lo: number;
  hi: number;
  volume: number;
  /** null is the explicit wire representation of age Infinity / unknown. */
  ageMs: number | null;
}

interface TransportState {
  segments: TransportSegment[];
}

interface StateResponse {
  serverNowMs: number;
  connected: boolean;
  /** Earliest instant for which all requested tokens have recorder coverage. */
  recordingSinceMs: number | null;
  /** Recorder coverage start for each requested token. */
  recordingSinceMsByToken: Record<string, number>;
  states: Record<string, TransportState>;
}

class AgeRecorder {
  private readonly client = createPublicClient();
  private readonly watched = new Set<string>();
  private readonly recordingSince = new Map<string, number>();
  private readonly books = new Map<string, TokenBook<string>>();
  private readonly memories = new Map<string, StaleSignedVolume>();
  private subscription: SubscriptionHandle<MarketEvent> | null = null;
  private subscriptionGeneration = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private restartChain = Promise.resolve();

  async start(): Promise<void> {
    await this.restoreFromDisk();
    void this.restartSubscription();
  }

  watch(tokenIds: Iterable<string>): boolean {
    let changed = false;
    const nowMs = Date.now();
    for (const tokenId of tokenIds) {
      if (!tokenId || this.watched.has(tokenId)) continue;
      this.watched.add(tokenId);
      this.recordingSince.set(tokenId, nowMs);
      changed = true;
    }
    if (!changed) return false;

    this.schedulePersist();
    // Registration/hydration must never block the UI on recorder connectivity.
    void this.restartSubscription();
    return true;
  }

  state(tokenIds: Iterable<string>): StateResponse {
    const requested = [...tokenIds];
    const nowMs = Date.now();
    const states: Record<string, TransportState> = {};
    for (const tokenId of requested) {
      const memory = this.memories.get(tokenId);
      if (!memory) continue;
      states[tokenId] = {
        segments: memory.segments(nowMs).map(({ ageMs, ...segment }) => ({
          ...segment,
          ageMs: ageMs === Infinity ? null : ageMs,
        })),
      };
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

    return {
      serverNowMs: nowMs,
      connected: this.subscription !== null,
      recordingSinceMs,
      recordingSinceMsByToken,
      states,
    };
  }

  stats() {
    const starts = [...this.recordingSince.values()];
    return {
      watchedTokens: this.watched.size,
      hydratedTokens: this.memories.size,
      liveBooks: this.books.size,
      connected: this.subscription !== null,
      oldestRecordingSinceMs: starts.length ? Math.min(...starts) : null,
      newestRecordingSinceMs: starts.length ? Math.max(...starts) : null,
      statePath: STATE_PATH,
    };
  }

  private restartSubscription(): Promise<void> {
    // Increment immediately so any currently retrying connection attempt can
    // observe that it is stale before the queued restart gets its turn.
    const generation = ++this.subscriptionGeneration;
    this.restartChain = this.restartChain.then(() => this.connect(generation));
    return this.restartChain;
  }

  private async connect(generation: number): Promise<void> {
    if (generation !== this.subscriptionGeneration) return;

    const previous = this.subscription;
    this.subscription = null;
    if (previous) await previous.close().catch(() => undefined);
    if (generation !== this.subscriptionGeneration) return;

    const tokenIds = [...this.watched];
    if (tokenIds.length === 0) return;

    for (;;) {
      try {
        const subscription = await this.client.subscribe([
          { topic: "market", tokenIds },
        ]);
        if (generation !== this.subscriptionGeneration) {
          await subscription.close().catch(() => undefined);
          return;
        }
        this.subscription = subscription;
        void this.consume(subscription, generation);
        return;
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        console.error("Recorder websocket connection failed; retrying…", error);
        await Bun.sleep(1_000);
        if (generation !== this.subscriptionGeneration) return;
      }
    }
  }

  private async consume(
    events: SubscriptionHandle<MarketEvent>,
    generation: number,
  ): Promise<void> {
    try {
      for await (const stream of events) {
        if (generation !== this.subscriptionGeneration) return;

        if (stream.type === "book") {
          const tokenId = String(stream.payload.tokenId);
          const book = bookFromSnapshot(stream.payload);
          this.books.set(tokenId, book);
          this.updateMemory(tokenId, book);
        } else if (stream.type === "price_change") {
          const observedByToken = new Map<string, PressureObservationRange[]>();
          for (const change of stream.payload.priceChanges) {
            const tokenId = String(change.tokenId);
            const book = this.books.get(tokenId);
            if (!book) continue;

            applyPriceChange(book, change);
            const price = Number(change.price);
            const ranges = observedByToken.get(tokenId) ?? [];
            ranges.push(
              change.side === OrderSide.BUY
                ? { lo: 0, hi: price }
                : { lo: price, hi: 1 },
            );
            observedByToken.set(tokenId, ranges);
          }

          for (const [tokenId, observedRanges] of observedByToken) {
            const book = this.books.get(tokenId);
            if (book) this.updateMemory(tokenId, book, observedRanges);
          }
        } else if (stream.type === "market_resolved") {
          let changed = false;
          for (const tokenIdValue of stream.payload.assetIds ?? []) {
            const tokenId = String(tokenIdValue);
            changed = this.watched.delete(tokenId) || changed;
            this.recordingSince.delete(tokenId);
            this.books.delete(tokenId);
          }
          if (changed) {
            this.schedulePersist();
            void this.restartSubscription();
          }
        }
      }
    } catch (error) {
      if (generation === this.subscriptionGeneration)
        console.error("Recorder websocket stream ended with error", error);
    } finally {
      if (
        generation === this.subscriptionGeneration &&
        this.subscription === events
      ) {
        this.subscription = null;
        void this.restartSubscription();
      }
    }
  }

  private updateMemory(
    tokenId: string,
    book: TokenBook<string>,
    observedRanges?: readonly PressureObservationRange[],
  ): void {
    const nowMs = Date.now();
    const memory = this.memories.get(tokenId) ?? new StaleSignedVolume();
    memory.update(book, nowMs, observedRanges);
    this.memories.set(tokenId, memory);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist().catch((error) =>
        console.error("Could not persist recorder state", error),
      );
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const states: Record<string, StaleSignedVolumeSnapshot> = {};
    for (const [tokenId, memory] of this.memories)
      states[tokenId] = memory.snapshot();

    const payload: PersistedRecorderState = {
      version: 1,
      watchedTokenIds: [...this.watched],
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
      parsed = JSON.parse(
        await readFile(STATE_PATH, "utf8"),
      ) as PersistedRecorderState;
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        console.warn("Ignoring unreadable recorder state", error);
      return;
    }

    if (parsed.version !== 1) {
      console.warn(`Ignoring unsupported recorder state v${parsed.version}`);
      return;
    }

    const migrationNowMs = Date.now();
    let repairedCoverageMetadata = false;

    for (const tokenId of parsed.watchedTokenIds ?? []) {
      if (typeof tokenId !== "string" || !tokenId) continue;
      this.watched.add(tokenId);

      const storedStart = validWallClockMs(
        parsed.recordingSinceMs?.[tokenId],
        migrationNowMs,
      );
      const inferredStart = earliestSnapshotObservationMs(
        parsed.states?.[tokenId],
        migrationNowMs,
      );
      const knownStarts = [storedStart, inferredStart].filter(
        (value): value is number => value !== undefined,
      );
      const repairedStart = knownStarts.length
        ? Math.min(...knownStarts)
        : migrationNowMs;

      this.recordingSince.set(tokenId, repairedStart);
      if (storedStart !== repairedStart) repairedCoverageMetadata = true;
    }

    for (const [tokenId, snapshot] of Object.entries(parsed.states ?? {})) {
      try {
        const memory = new StaleSignedVolume();
        memory.restore(snapshot);
        this.memories.set(tokenId, memory);
      } catch (error) {
        console.warn(`Ignoring invalid recorder state for ${tokenId}`, error);
      }
    }

    // Older recorder versions did not persist coverage starts. A later version
    // initially migrated those missing values to restart time, which can also
    // leave already-written metadata newer than observations still present in
    // the snapshots. Repair both cases and persist the correction immediately.
    if (repairedCoverageMetadata) this.schedulePersist();
  }
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

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return response(null, 204);

    if (url.pathname === "/api/recorder/health")
      return response(recorder.stats());

    if (url.pathname === "/api/recorder/state" && request.method === "GET") {
      const tokenIds = parseTokenIds(url.searchParams);
      recorder.watch(tokenIds);
      return response(recorder.state(tokenIds));
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
