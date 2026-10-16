import { expect, test, spyOn } from "bun:test";
import {
  RateLimitError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import {
  BookRefreshCoordinator,
  STALE_BOOK_VERIFY_MS,
  type BookRefreshSubscriber,
  type BookRefreshSnapshot,
} from "./bookRefreshCoordinator";
import {
  withFakeTimers,
  flushMicrotasks,
} from "../../shared/testing/fakeTimers";

const A = "1001" as TokenId;
const B = "1002" as TokenId;

// Drive the real scheduler with a controlled wall clock and timer queue.
test("refresh scheduling honors 429 Retry-After, pacing and failure backoff", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let now = 100_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay: number) {
        timers.set(++timerId, { callback, delay });
        return timerId;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
  });
  let resolve!: (value: []) => void;
  let reject!: (error: unknown) => void;
  let calls = 0;
  const client = {
    fetchOrderBooks: () => {
      calls++;
      return new Promise<[]>((yes, no) => {
        resolve = yes;
        reject = no;
      });
    },
  } as unknown as PublicClient;
  const watcher: BookRefreshSubscriber = {
    onBookRefreshStarted() {},
    onBookRefreshSnapshot() {},
    onBookRefreshFinished() {},
  };
  const scheduler = new BookRefreshCoordinator(client);
  const runTimer = () => {
    const [id, { callback }] = [...timers][0]!;
    timers.delete(id);
    callback();
  };
  try {
    scheduler.observe(watcher, B, now - STALE_BOOK_VERIFY_MS - 100);
    scheduler.observe(watcher, A, now - STALE_BOOK_VERIFY_MS - 200);
    runTimer();
    expect(calls).toBe(1);
    reject(new RateLimitError("Too many requests", { retryAfter: 5 }));
    await Promise.resolve();
    await Promise.resolve();
    expect([...timers.values()][0]!.delay).toBe(5_000);
    now += 5_000;
    runTimer();
    resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect([...timers.values()][0]!.delay).toBe(STALE_BOOK_VERIFY_MS);
    now += STALE_BOOK_VERIFY_MS;
    runTimer();
    reject(new Error("Offline"));
    await Promise.resolve();
    await Promise.resolve();
    expect([...timers.values()][0]!.delay).toBe(1_000);
  } finally {
    scheduler.unwatchAll(watcher);
    clock.mockRestore();
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

function fixture() {
  const pending: {
    ids: readonly TokenId[];
    resolve: (value: BookRefreshSnapshot[]) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const client = {
    fetchOrderBooks: (request: { assetId: TokenId }[]) =>
      new Promise<BookRefreshSnapshot[]>((resolve, reject) =>
        pending.push({
          ids: request.map((item) => item.assetId),
          resolve,
          reject,
        }),
      ),
  } as unknown as PublicClient;
  const received: BookRefreshSnapshot[] = [];
  const missing: TokenId[] = [];
  const watcher: BookRefreshSubscriber = {
    onBookRefreshStarted() {},
    onBookRefreshSnapshot: (_, __, ___, snapshot) => received.push(snapshot),
    onBookRefreshUnavailable: (id) => missing.push(id),
    onBookRefreshFinished() {},
  };
  const scheduler = new BookRefreshCoordinator(client);
  return { pending, received, missing, watcher, scheduler };
}

test("omitted books back off per token instead of immediately retrying stale deadlines", () =>
  withFakeTimers(async (clock) => {
    const { pending, received, missing, watcher, scheduler } = fixture();
    scheduler.observe(watcher, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
    for (const delayMs of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      clock.runNext();
      pending.at(-1)!.resolve([]);
      await flushMicrotasks();
      expect(clock.nextDelayMs).toBe(delayMs);
      // Re-reporting an old observation must not defeat the backoff.
      scheduler.observe(watcher, A, 1);
      expect(clock.nextDelayMs).toBe(delayMs);
    }
    expect(missing).toEqual(Array(6).fill(A));
    expect(received).toEqual([]);
    scheduler.unwatchAll(watcher);
    expect(clock.nextDelayMs).toBe(Infinity);
  }));

test("a real empty snapshot is delivered, while an omitted sibling is not fabricated", () =>
  withFakeTimers(async (clock) => {
    const { pending, received, missing, watcher, scheduler } = fixture();
    scheduler.observe(watcher, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
    scheduler.observe(watcher, B, clock.nowMs - STALE_BOOK_VERIFY_MS);
    clock.runNext();
    const empty = {
      assetId: A,
      bids: [],
      asks: [],
      timestamp: String(clock.nowMs),
    } as unknown as BookRefreshSnapshot;
    pending[0]!.resolve([empty]);
    await flushMicrotasks();
    expect(received).toEqual([empty]);
    expect(missing).toEqual([B]);
    expect(clock.nextDelayMs).toBe(STALE_BOOK_VERIFY_MS);

    clock.runNext();
    pending[1]!.resolve([empty]);
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(STALE_BOOK_VERIFY_MS);
    clock.runNext();
    expect(pending[2]!.ids).toEqual([A]); // B alone is in a longer backoff.
    pending[2]!.resolve([empty]);
    await flushMicrotasks();
    scheduler.unwatchAll(watcher);
  }));

test("fresh stream evidence resets missing-book backoff without advancing fictitious observations", () =>
  withFakeTimers(async (clock) => {
    const { pending, watcher, scheduler } = fixture();
    scheduler.observe(watcher, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
    for (let index = 0; index < 2; index++) {
      clock.runNext();
      pending[index]!.resolve([]);
      await flushMicrotasks();
    }
    expect(clock.nextDelayMs).toBe(10_000);
    clock.nowMs += 3_000;
    scheduler.observe(watcher, A, clock.nowMs);
    expect(clock.nextDelayMs).toBe(STALE_BOOK_VERIFY_MS);
    clock.runNext();
    pending[2]!.resolve([]);
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(5_000);
    scheduler.unwatchAll(watcher);
  }));

test("request failures neither deliver empty books nor report unavailable tokens", () =>
  withFakeTimers(async (clock) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { pending, received, missing, watcher, scheduler } = fixture();
    try {
      scheduler.observe(watcher, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
      clock.runNext();
      pending[0]!.reject(new Error("request failed"));
      await flushMicrotasks();
      expect(received).toEqual([]);
      expect(missing).toEqual([]);
      expect(clock.nextDelayMs).toBe(1_000);
    } finally {
      scheduler.unwatchAll(watcher);
      warn.mockRestore();
    }
  }));

test("a late response cannot publish into a removed and re-added token", () =>
  withFakeTimers(async (clock) => {
    const { pending, received, missing, watcher, scheduler } = fixture();
    scheduler.observe(watcher, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
    clock.runNext();
    scheduler.unwatchAll(watcher);
    scheduler.observe(watcher, A, clock.nowMs);
    pending[0]!.resolve([]);
    await flushMicrotasks();
    expect(received).toEqual([]);
    expect(missing).toEqual([]);
    expect(clock.nextDelayMs).toBe(STALE_BOOK_VERIFY_MS);
    scheduler.unwatchAll(watcher);
  }));

test("a slow successful check cannot immediately retry its old request timestamp", () =>
  withFakeTimers(async (clock) => {
    const { pending, watcher, scheduler } = fixture();
    const accepting: BookRefreshSubscriber = {
      ...watcher,
      onBookRefreshSnapshot: (id, _, requestedAtMs) =>
        scheduler.observe(accepting, id, requestedAtMs),
    };
    scheduler.observe(accepting, A, clock.nowMs - STALE_BOOK_VERIFY_MS);
    clock.runNext();
    clock.nowMs += 60_000;
    pending[0]!.resolve([
      {
        assetId: A,
        bids: [],
        asks: [],
        timestamp: String(clock.nowMs),
      } as unknown as BookRefreshSnapshot,
    ]);
    await flushMicrotasks();
    expect(clock.nextDelayMs).toBe(STALE_BOOK_VERIFY_MS);
    scheduler.unwatchAll(accepting);
  }));
