import { expect, test } from "bun:test";
import { canonicalSpread, type TokenBook } from "@/lib/orderBook";
import { parsePrice } from "@/lib/price";
import {
  LiveBookCoordinator,
  type LiveBookFeedCallbacks,
  type LiveBookUpdate,
} from "./liveBookCoordinator";
import type {
  BookRefreshSnapshot,
  BookRefreshSubscriber,
} from "./bookRefreshCoordinator";
import {
  TransportError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";

const TOKEN_A = "1001" as TokenId;
const TOKEN_B = "1002" as TokenId;
const TOKEN_C = "1003" as TokenId;
const MARKET_A = "market-a";
const MARKET_B = "market-b";

test("coalesces watches into one steady subscription and replays cached books", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const first = callbackLog();
  const second = callbackLog();

  const firstWatch = coordinator.watch([TOKEN_B, TOKEN_A], first.callbacks);
  await firstWatch.ready;
  expect(client.assetIds()).toEqual([[TOKEN_A, TOKEN_B]]);
  expect(first.statuses).toEqual(["connecting", "live"]);

  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  const canonicalBook = coordinator.getBook(TOKEN_A);
  if (!canonicalBook) throw new Error("canonical book was not created");

  const secondWatch = coordinator.watch([TOKEN_C, TOKEN_A], second.callbacks);
  await secondWatch.ready;
  expect(client.assetIds()).toEqual([
    [TOKEN_A, TOKEN_B],
    [TOKEN_A, TOKEN_B, TOKEN_C],
  ]);
  expect(client.streams[0]!.closeCount).toBe(1);
  expect(client.streams[1]!.closeCount).toBe(0);
  expect(second.updates).toHaveLength(1);
  expect(second.updates[0]!.kind).toBe("snapshot");
  expect(second.updates[0]!.book).toBe(canonicalBook);

  firstWatch.close();
  secondWatch.close();
  await flush();
  expect(client.latest().closeCount).toBe(1);
});

test("partitions mixed changes once and shares one canonical mutation", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const first = callbackLog();
  const second = callbackLog();

  const firstWatch = coordinator.watch([TOKEN_A, TOKEN_B], first.callbacks);
  const secondWatch = coordinator.watch([TOKEN_A], second.callbacks);
  await Promise.all([firstWatch.ready, secondWatch.ready]);
  expect(client.streams).toHaveLength(1);

  const stream = client.latest();
  stream.push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  stream.push(bookEvent(TOKEN_B, 1_100, "0.30", "0.70"));
  await flush();
  first.updates.length = 0;
  second.updates.length = 0;

  stream.push(
    priceChangeEvent(1_200, [
      { tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "25" },
      { tokenId: TOKEN_B, side: "SELL", price: "0.70", size: "35" },
      { tokenId: TOKEN_C, side: "BUY", price: "0.20", size: "99" },
    ]),
  );
  await flush();

  expect(first.updates.map(({ tokenId, kind }) => [tokenId, kind])).toEqual([
    [TOKEN_A, "levels"],
    [TOKEN_B, "levels"],
  ]);
  expect(second.updates.map(({ tokenId, kind }) => [tokenId, kind])).toEqual([
    [TOKEN_A, "levels"],
  ]);
  expect(first.updates[0]!.book).toBe(second.updates[0]!.book);
  expect([...coordinator.getBook(TOKEN_A)!.usdToYes.asOrders()][0]?.take).toBe(
    25,
  );
  expect(
    [...coordinator.getBook(TOKEN_B)!.yesToUsd.asSellOrders()][0]?.take,
  ).toBe(35);

  firstWatch.close();
  secondWatch.close();
});

test("preserves the canonical book across same-turn feed replacement", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const first = callbackLog();
  const firstWatch = coordinator.watch([TOKEN_A], first.callbacks);
  await firstWatch.ready;
  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  const book = coordinator.getBook(TOKEN_A);
  if (!book) throw new Error("canonical book was not created");

  firstWatch.close();
  const replacement = callbackLog();
  const replacementWatch = coordinator.watch([TOKEN_A], replacement.callbacks);
  await replacementWatch.ready;

  expect(client.streams).toHaveLength(1);
  expect(coordinator.getBook(TOKEN_A)).toBe(book);
  expect(replacement.updates).toHaveLength(1);
  expect(replacement.updates[0]!.book).toBe(book);
  replacementWatch.close();
});

test("hands subscription ownership over without replaying overlap events", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const handoff = deferred<void>();
  const coordinator = createCoordinator(client, refresh, {
    handoffYield: () => handoff.promise,
  });
  const log = callbackLog();
  const firstWatch = coordinator.watch([TOKEN_A], log.callbacks);
  await firstWatch.ready;
  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  log.updates.length = 0;

  const secondWatch = coordinator.watch([TOKEN_B], callbackLog().callbacks);
  await waitFor(() => client.streams.length === 2);
  const oldStream = client.streams[0]!;
  const replacement = client.streams[1]!;
  const beforeHandoff = priceChangeEvent(1_200, [
    { tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "15" },
  ]);
  const overlap = priceChangeEvent(1_300, [
    { tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "20" },
  ]);
  oldStream.push(beforeHandoff);
  oldStream.push(overlap);
  replacement.push(overlap);
  await flush();
  expect(log.updates.map(({ validThroughMs }) => validThroughMs)).toEqual([
    1_200, 1_300,
  ]);

  handoff.resolve();
  await secondWatch.ready;
  await flush();
  expect(log.updates.map(({ validThroughMs }) => validThroughMs)).toEqual([
    1_200, 1_300,
  ]);
  expect([...coordinator.getBook(TOKEN_A)!.usdToYes.asOrders()][0]?.take).toBe(
    20,
  );

  firstWatch.close();
  secondWatch.close();
});

test("identical REST snapshot safely confirms freshness without reconnecting", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A], log.callbacks);
  await watch.ready;

  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  log.updates.length = 0;

  refresh.start(TOKEN_A, 1, 2_000);
  refresh.snapshot(
    TOKEN_A,
    1,
    2_000,
    refreshSnapshot(TOKEN_A, 2_050, "0.40", "0.60", "10"),
  );
  await flush();

  expect(client.streams).toHaveLength(1);
  expect(log.updates.at(-1)).toMatchObject({
    kind: "snapshot",
    validThroughMs: 2_000,
  });
  watch.close();
});

test("differing REST snapshot forces a fresh websocket barrier", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A], log.callbacks);
  await watch.ready;

  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  const staleBook = coordinator.getBook(TOKEN_A);
  if (!staleBook) throw new Error("expected cached book");

  refresh.start(TOKEN_A, 1, 2_000);
  refresh.snapshot(
    TOKEN_A,
    1,
    2_000,
    refreshSnapshot(TOKEN_A, 2_050, "0.30", "0.70", "100"),
  );
  await waitFor(() => client.streams.length === 2);

  // The old book remains displayable but is inert on the new stream.
  expect(coordinator.getBook(TOKEN_A)).toBe(staleBook);
  const replacement = client.latest();
  replacement.push(
    priceChangeEvent(2_100, [
      { tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "99" },
    ]),
  );
  await flush();
  expect([...coordinator.getBook(TOKEN_A)!.usdToYes.asOrders()][0]?.take).toBe(
    10,
  );

  replacement.push(bookEvent(TOKEN_A, 2_200, "0.45", "0.65"));
  await flush();
  expect(canonicalSpread(coordinator.getBook(TOKEN_A)!)).toEqual({
    bid: parsePrice("0.45"),
    ask: parsePrice("0.65"),
  });
  expect(log.updates.at(-1)).toMatchObject({
    kind: "snapshot",
    validThroughMs: 2_200,
  });
  watch.close();
});

test("same-market events advance unchanged sibling tokens", async () => {
  const client = new FakeClient();
  const coordinator = createCoordinator(client, new FakeRefreshScheduler());
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A, TOKEN_B], log.callbacks);
  await watch.ready;

  const stream = client.latest();
  stream.push(bookEvent(TOKEN_A, 1_000, "0.40", "0.60", MARKET_A));
  stream.push(bookEvent(TOKEN_B, 1_000, "0.30", "0.70", MARKET_A));
  await flush();
  log.updates.length = 0;

  stream.push(
    priceChangeEvent(
      1_500,
      [{ tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "12" }],
      MARKET_A,
    ),
  );
  await flush();

  expect(
    log.updates.map(({ tokenId, kind, validThroughMs }) => [
      tokenId,
      kind,
      validThroughMs,
    ]),
  ).toEqual([
    [TOKEN_B, "watermark", 1_500],
    [TOKEN_A, "levels", 1_500],
  ]);
  watch.close();
});

test("same-market timestamp regressions are max-aggregated without reconnecting", async () => {
  const client = new FakeClient();
  const coordinator = createCoordinator(client, new FakeRefreshScheduler());
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A, TOKEN_B], log.callbacks);
  await watch.ready;

  const stream = client.latest();
  stream.push(bookEvent(TOKEN_A, 1_001, "0.40", "0.60", MARKET_A));
  stream.push(bookEvent(TOKEN_B, 1_001, "0.30", "0.70", MARKET_A));
  await flush();
  log.updates.length = 0;

  stream.push(
    priceChangeEvent(
      1_000,
      [{ tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "12" }],
      MARKET_A,
    ),
  );
  await flush();

  expect(client.streams).toHaveLength(1);
  expect(log.statuses).toEqual(["connecting", "live"]);
  expect(
    log.updates.map(({ tokenId, kind, validThroughMs }) => [
      tokenId,
      kind,
      validThroughMs,
    ]),
  ).toEqual([
    [TOKEN_B, "watermark", 1_001],
    [TOKEN_A, "levels", 1_001],
  ]);

  watch.close();
});

test("different markets never cross-advance their watermarks", async () => {
  const client = new FakeClient();
  const coordinator = createCoordinator(client, new FakeRefreshScheduler());
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A, TOKEN_B], log.callbacks);
  await watch.ready;

  const stream = client.latest();
  stream.push(bookEvent(TOKEN_A, 1_000, "0.40", "0.60", MARKET_A));
  stream.push(bookEvent(TOKEN_B, 1_000, "0.30", "0.70", MARKET_B));
  await flush();
  log.updates.length = 0;

  stream.push(
    priceChangeEvent(
      1_500,
      [{ tokenId: TOKEN_A, side: "BUY", price: "0.40", size: "12" }],
      MARKET_A,
    ),
  );
  await flush();

  expect(log.updates.map(({ tokenId, kind }) => [tokenId, kind])).toEqual([
    [TOKEN_A, "levels"],
  ]);
  watch.close();
});

test("resolves each subscriber once and removes resolved token state", async () => {
  const client = new FakeClient();
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh);
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A, TOKEN_B], log.callbacks);
  await watch.ready;

  client.latest().push(resolutionEvent([TOKEN_A, TOKEN_B]));
  await flush();
  expect(log.resolutions).toHaveLength(1);
  expect(coordinator.getBook(TOKEN_A)).toBeUndefined();
  expect(coordinator.getBook(TOKEN_B)).toBeUndefined();
  expect(client.latest().closeCount).toBe(1);
  expect(refresh.unwatched).toEqual([TOKEN_A, TOKEN_B]);
  watch.close();
});

test("retries transport failures and reconnects a terminal stream", async () => {
  const client = new FakeClient();
  client.failures.push(new TransportError("offline"));
  const refresh = new FakeRefreshScheduler();
  const coordinator = createCoordinator(client, refresh, { retryDelayMs: 0 });
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A], log.callbacks);
  await watch.ready;
  expect(client.subscribeAttempts).toBe(2);
  expect(log.statuses).toEqual(["connecting", "live"]);

  client.latest().push(bookEvent(TOKEN_A, 1_100, "0.40", "0.60"));
  await flush();
  client.latest().end();
  await waitFor(() => client.streams.length === 2);
  await flush();
  expect(log.statuses).toEqual([
    "connecting",
    "live",
    "disconnected",
    "connecting",
    "live",
  ]);
  expect(canonicalSpread(coordinator.getBook(TOKEN_A)!)).toEqual({
    bid: parsePrice("0.40"),
    ask: parsePrice("0.60"),
  });

  client.latest().push(bookEvent(TOKEN_A, 1_200, "0.42", "0.62"));
  await flush();
  expect(canonicalSpread(coordinator.getBook(TOKEN_A)!)).toEqual({
    bid: parsePrice("0.42"),
    ask: parsePrice("0.62"),
  });
  watch.close();
});

test("closing a pending watch retires its eventual subscription", async () => {
  const client = new FakeClient();
  const gate = deferred<void>();
  client.gates.push(gate.promise);
  const coordinator = createCoordinator(client, new FakeRefreshScheduler());
  const log = callbackLog();
  const watch = coordinator.watch([TOKEN_A], log.callbacks);
  await waitFor(() => client.subscribeAttempts === 1);

  watch.close();
  gate.resolve();
  await watch.ready;
  await waitFor(
    () => client.streams.length === 1 && client.streams[0]!.closeCount === 1,
  );
  expect(log.statuses).toEqual(["connecting"]);
  expect(coordinator.getBook(TOKEN_A)).toBeUndefined();
});

function createCoordinator(
  client: FakeClient,
  refresh: FakeRefreshScheduler,
  options: Partial<ConstructorParameters<typeof LiveBookCoordinator>[1]> = {},
): LiveBookCoordinator {
  return new LiveBookCoordinator(client as unknown as PublicClient, {
    refreshScheduler: refresh,
    now: () => 1_000,
    debug: false,
    handoffYield: async () => undefined,
    ...options,
  });
}

interface LoggedUpdate {
  readonly tokenId: TokenId;
  readonly book: TokenBook;
  readonly kind: LiveBookUpdate["kind"];
  readonly validThroughMs: number;
}

function callbackLog(): {
  readonly callbacks: LiveBookFeedCallbacks;
  readonly statuses: string[];
  readonly updates: LoggedUpdate[];
  readonly resolutions: unknown[];
} {
  const statuses: string[] = [];
  const updates: LoggedUpdate[] = [];
  const resolutions: unknown[] = [];
  return {
    statuses,
    updates,
    resolutions,
    callbacks: {
      onConnectionStatus: (status) => statuses.push(status),
      onBookUpdated: (tokenId, book, update) =>
        updates.push({
          tokenId,
          book,
          kind: update.kind,
          validThroughMs: update.validThroughMs,
        }),
      onMarketResolved: (resolution) => resolutions.push(resolution),
    },
  };
}

class FakeClient {
  readonly streams: ControlledStream[] = [];
  readonly subscriptions: TokenId[][] = [];
  readonly failures: Error[] = [];
  readonly gates: Promise<void>[] = [];
  subscribeAttempts = 0;

  async subscribe(
    specs: readonly {
      readonly topic: string;
      readonly assetIds: readonly TokenId[];
    }[],
  ): Promise<SubscriptionHandle<MarketEvent>> {
    this.subscribeAttempts++;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const gate = this.gates.shift();
    if (gate) await gate;

    const stream = new ControlledStream();
    this.streams.push(stream);
    this.subscriptions.push([...(specs[0]?.assetIds ?? [])]);
    return stream;
  }

  latest(): ControlledStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no fake subscription");
    return stream;
  }

  assetIds(): TokenId[][] {
    return this.subscriptions;
  }
}

class ControlledStream implements SubscriptionHandle<MarketEvent> {
  private readonly queued: MarketEvent[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<MarketEvent>) => void
  > = [];
  private ended = false;
  closeCount = 0;

  push(event: MarketEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.queued.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined });
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<MarketEvent> {
    return {
      next: () => {
        const event = this.queued.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => ({ done: true, value: undefined }),
    };
  }
}

class FakeRefreshScheduler {
  subscriber: BookRefreshSubscriber | undefined;
  readonly unwatched: TokenId[] = [];

  observe(
    subscriber: BookRefreshSubscriber,
    _tokenId: TokenId,
    _validThroughMs: number,
  ): void {
    this.subscriber = subscriber;
  }

  unwatch(_subscriber: BookRefreshSubscriber, tokenId: TokenId): void {
    this.unwatched.push(tokenId);
  }

  unwatchAll(_subscriber: BookRefreshSubscriber): void {}

  start(tokenId: TokenId, requestId: number, requestedAtMs: number): void {
    this.expectSubscriber().onBookRefreshStarted(
      tokenId,
      requestId,
      requestedAtMs,
    );
  }

  snapshot(
    tokenId: TokenId,
    requestId: number,
    requestedAtMs: number,
    snapshot: BookRefreshSnapshot,
  ): void {
    this.expectSubscriber().onBookRefreshSnapshot(
      tokenId,
      requestId,
      requestedAtMs,
      snapshot,
    );
  }

  private expectSubscriber(): BookRefreshSubscriber {
    if (!this.subscriber) throw new Error("book was not observed");
    return this.subscriber;
  }
}

function bookEvent(
  tokenId: TokenId,
  timestamp: number,
  bid: string,
  ask: string,
  market = MARKET_A,
): MarketEvent {
  return {
    type: "book",
    payload: {
      assetId: tokenId,
      market,
      timestamp: String(timestamp),
      bids: [{ price: bid, size: "10" }],
      asks: [{ price: ask, size: "10" }],
    },
  } as unknown as MarketEvent;
}

function priceChangeEvent(
  timestamp: number,
  changes: readonly {
    readonly tokenId: TokenId;
    readonly side: string;
    readonly price: string;
    readonly size: string;
  }[],
  market = MARKET_A,
): MarketEvent {
  return {
    type: "price_change",
    payload: {
      market,
      timestamp: String(timestamp),
      priceChanges: changes.map((change) => ({
        assetId: change.tokenId,
        side: change.side,
        price: change.price,
        size: change.size,
      })),
    },
  } as unknown as MarketEvent;
}

function resolutionEvent(assetIds: readonly TokenId[]): MarketEvent {
  return {
    type: "market_resolved",
    payload: {
      conditionId: "condition-1",
      assetIds,
      winningAssetId: assetIds[0],
      winningOutcome: "Yes",
      timestamp: "1500",
    },
  } as unknown as MarketEvent;
}

function refreshSnapshot(
  tokenId: TokenId,
  timestamp: number,
  bid: string,
  ask: string,
  bidSize: string,
): BookRefreshSnapshot {
  return {
    assetId: tokenId,
    timestamp: String(timestamp),
    bids: [{ price: bid, size: bidSize }],
    asks: [{ price: ask, size: "10" }],
  } as unknown as BookRefreshSnapshot;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
