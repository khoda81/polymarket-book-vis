import {
  createPublicClient,
  OrderSide,
  type PublicClient,
  type TokenId,
  TransportError,
} from "@polymarket/client";
import type {
  MarketEvent,
  SubscriptionHandle,
} from "@polymarket/client/actions";
import {
  HalfBook,
  canonicalSpread,
  type TokenBook,
} from "../src/lib/orderBook";
import { SpreadAge } from "../src/lib/spreadAge";
import { AgeStore, type StoredAgeState, type TrackedToken } from "./store";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const SUBSCRIPTION_BATCH_SIZE = 200;

interface Spread {
  readonly bid: number;
  readonly ask: number;
}

export class AgeCollector {
  private readonly client: PublicClient;
  private readonly books = new Map<string, TokenBook<string>>();
  private readonly ages = new Map<string, SpreadAge>();
  private readonly spreads = new Map<string, Spread>();
  private readonly subscribed = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly handles = new Set<SubscriptionHandle<MarketEvent>>();
  private stopped = false;

  constructor(
    readonly store: AgeStore,
    client: PublicClient = createPublicClient(),
  ) {
    this.client = client;
  }

  start(): void {
    const tracked = this.store.trackedTokens();
    for (let i = 0; i < tracked.length; i += SUBSCRIPTION_BATCH_SIZE)
      this.subscribeForever(tracked.slice(i, i + SUBSCRIPTION_BATCH_SIZE));
  }

  track(tokens: readonly TrackedToken[]): void {
    const normalized = dedupeTokens(tokens);
    this.store.track(normalized);

    const newTokens = normalized.filter(
      (token) => !this.subscribed.has(token.tokenId),
    );
    if (newTokens.length === 0) return;

    for (let i = 0; i < newTokens.length; i += SUBSCRIPTION_BATCH_SIZE)
      this.subscribeForever(newTokens.slice(i, i + SUBSCRIPTION_BATCH_SIZE));
  }

  states(tokenIds: readonly string[]): StoredAgeState[] {
    return this.store.ageStates(tokenIds);
  }

  trackedCount(): number {
    return this.subscribed.size;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const handles = [...this.handles];
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.close()));
    await Promise.allSettled([...this.tasks]);
  }

  private subscribeForever(tokens: readonly TrackedToken[]): void {
    const tokenIds = tokens.map((token) => token.tokenId);
    if (tokenIds.length === 0) return;
    for (const tokenId of tokenIds) this.subscribed.add(tokenId);

    const task = this.runSubscription(tokenIds).finally(() => {
      this.tasks.delete(task);
      for (const tokenId of tokenIds) this.subscribed.delete(tokenId);
    });
    this.tasks.add(task);
  }

  private async runSubscription(tokenIds: readonly string[]): Promise<void> {
    let retryMs = RETRY_BASE_MS;

    while (!this.stopped) {
      // Any gap in observation makes prior continuity unprovable.
      this.resetContinuity(tokenIds);

      try {
        const handle = await this.client.subscribe([
          { topic: "market", tokenIds: tokenIds as TokenId[] },
        ]);
        this.handles.add(handle);
        retryMs = RETRY_BASE_MS;
        await this.readEvents(handle);
        this.handles.delete(handle);
        if (this.stopped) return;
      } catch (error) {
        if (this.stopped) return;
        if (!(error instanceof TransportError))
          console.error("age collector subscription failed", error);
      }

      await sleep(retryMs);
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }
  }

  private resetContinuity(tokenIds: readonly string[]): void {
    this.store.invalidateAgeStates(tokenIds);
    for (const tokenId of tokenIds) {
      this.books.delete(tokenId);
      this.ages.delete(tokenId);
      this.spreads.delete(tokenId);
    }
  }

  private async readEvents(events: SubscriptionHandle<MarketEvent>): Promise<void> {
    for await (const stream of events) {
      if (this.stopped) return;

      if (stream.type === "book") {
        const tokenId = stream.payload.tokenId as string;
        const book = bookFromSnapshot(stream.payload.bids, stream.payload.asks);
        this.books.set(tokenId, book);
        this.updateSpread(tokenId, Date.now(), true);
        continue;
      }

      if (stream.type === "price_change") {
        const affected = new Set<string>();
        for (const change of stream.payload.priceChanges) {
          const tokenId = change.tokenId as string;
          const book = this.books.get(tokenId);
          if (!book) continue;

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
          affected.add(tokenId);
        }

        const nowMs = Date.now();
        for (const tokenId of affected) this.updateSpread(tokenId, nowMs, false);
        continue;
      }

      if (stream.type === "market_resolved") {
        for (const tokenId of stream.payload.assetIds ?? []) {
          const id = tokenId as string;
          this.books.delete(id);
          this.ages.delete(id);
          this.spreads.delete(id);
        }
      }
    }
  }

  private updateSpread(tokenId: string, nowMs: number, initial: boolean): void {
    const book = this.books.get(tokenId);
    if (!book) return;

    const spread = canonicalSpread(book);
    const previous = this.spreads.get(tokenId);
    if (
      !initial &&
      previous &&
      previous.bid === spread.bid &&
      previous.ask === spread.ask
    )
      return;

    let age = this.ages.get(tokenId);
    if (!age || initial) {
      age = new SpreadAge();
      this.ages.set(tokenId, age);
    }
    age.update(spread.bid, spread.ask, nowMs);
    this.spreads.set(tokenId, spread);

    this.store.saveAgeState({
      tokenId,
      bid: spread.bid,
      ask: spread.ask,
      observedAtMs: nowMs,
      snapshot: age.snapshot(),
    });
  }
}

function bookFromSnapshot(
  bids: readonly { price: string; size: string }[],
  asks: readonly { price: string; size: string }[],
): TokenBook<string> {
  const usdToYes = new HalfBook<string>();
  for (const bid of bids) {
    const price = Number(bid.price);
    usdToYes.setLevel(bid.price, { price, take: Number(bid.size) });
  }

  const yesToUsd = new HalfBook<string>();
  for (const ask of asks) {
    const canonicalPrice = Number(ask.price);
    yesToUsd.setLevel(ask.price, {
      price: 1 / canonicalPrice,
      take: Number(ask.size) * canonicalPrice,
    });
  }
  yesToUsd.setLevel("mint", { price: 1, take: Infinity });

  return { usdToYes, yesToUsd };
}

function dedupeTokens(tokens: readonly TrackedToken[]): TrackedToken[] {
  const byId = new Map<string, TrackedToken>();
  for (const token of tokens) {
    if (!token.tokenId) continue;
    byId.set(token.tokenId, token);
  }
  return [...byId.values()];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
