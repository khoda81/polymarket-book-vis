import { spyOn } from "bun:test";

/** Advance wall time separately from the timer queue to model OS sleep. */
export class FakeTimers {
  nowMs = 100_000;
  private nextId = 0;
  private readonly timers = new Map<
    number,
    { atMs: number; callback: () => void }
  >();

  readonly setTimeout = (callback: () => void, delayMs = 0): number => {
    const id = ++this.nextId;
    this.timers.set(id, { atMs: this.nowMs + delayMs, callback });
    return id;
  };
  readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };

  get nextDelayMs(): number {
    return this.timers.size === 0
      ? Infinity
      : Math.max(
          0,
          Math.min(...[...this.timers.values()].map((timer) => timer.atMs)) -
            this.nowMs,
        );
  }

  runNext(): void {
    const [id, timer] =
      [...this.timers.entries()].sort(
        (left, right) => left[1].atMs - right[1].atMs,
      )[0] ?? [];
    if (id === undefined || !timer) throw new Error("No pending fake timer");
    this.nowMs = Math.max(this.nowMs, timer.atMs);
    this.timers.delete(id);
    timer.callback();
  }
}

export async function withFakeTimers(
  run: (clock: FakeTimers) => void | Promise<void>,
): Promise<void> {
  const clock = new FakeTimers();
  const globals = {
    window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const descriptors = Object.keys(globals).map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  const now = spyOn(Date, "now").mockImplementation(() => clock.nowMs);
  Object.entries(globals).forEach(([key, value]) =>
    Object.defineProperty(globalThis, key, { configurable: true, value }),
  );
  try {
    await run(clock);
  } finally {
    now.mockRestore();
    Object.keys(globals).forEach((key, index) => {
      const original = descriptors[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
