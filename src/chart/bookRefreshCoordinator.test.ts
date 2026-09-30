import { expect, test, spyOn } from "bun:test";
import {
  RateLimitError,
  type PublicClient,
  type TokenId,
} from "@polymarket/client";
import {
  BookRefreshCoordinator,
  type BookRefreshSubscriber,
} from "./bookRefreshCoordinator";

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
    scheduler.observe(watcher, B, now - 100);
    scheduler.observe(watcher, A, now - 200);
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
    expect([...timers.values()][0]!.delay).toBe(20);
    now += 20;
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
