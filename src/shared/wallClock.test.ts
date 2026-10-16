import { expect, spyOn, test } from "bun:test";
import { marketTimeDisplay } from "../domain/markets/marketDeadline";
import { startWallClock, WallClock, type WallClockWatch } from "./wallClock";

test("frames update the shared time but render only at absolute deadlines", () => {
  const clock = new WallClock(1_000);
  const calls: number[] = [];
  clock.watch((nowMs) => {
    calls.push(nowMs);
    return nowMs + 100;
  });

  for (let nowMs = 1_001; nowMs < 1_100; nowMs++) clock.tick(nowMs);
  expect(clock.nowMs).toBe(1_099);
  expect(calls).toEqual([1_000]);
  clock.tick(1_100);
  expect(calls).toEqual([1_000, 1_100]);
  clock.tick(1_199);
  expect(calls).toHaveLength(2);
});

test("a forward jump renders once at the current time without replaying missed ticks", () => {
  const clock = new WallClock(1_000);
  const calls: number[] = [];
  clock.watch((nowMs) => {
    calls.push(nowMs);
    return nowMs + 100;
  });

  clock.tick(1_000_000);
  expect(calls).toEqual([1_000, 1_000_000]);
  clock.tick(1_000_099);
  expect(calls).toHaveLength(2);
  clock.tick(1_000_100);
  expect(calls).toEqual([1_000, 1_000_000, 1_000_100]);
});

test("a due display does not redraw siblings whose deadlines are still ahead", () => {
  const clock = new WallClock(0);
  const calls: string[] = [];
  for (const delay of [10, 100])
    clock.watch((nowMs) => {
      calls.push(`${delay}:${nowMs}`);
      return nowMs + delay;
    });

  clock.tick(10);
  clock.tick(20);
  expect(calls).toEqual(["10:0", "100:0", "10:10", "10:20"]);
  clock.tick(100);
  expect(calls.slice(-2)).toEqual(["10:100", "100:100"]);
});

test("a backwards wall-time adjustment refreshes displays and resets their deadlines", () => {
  const clock = new WallClock(1_000);
  const calls: number[] = [];
  const unscheduled: number[] = [];
  clock.watch((nowMs) => {
    calls.push(nowMs);
    return nowMs + 100;
  });
  clock.watch((nowMs) => {
    unscheduled.push(nowMs);
    return null;
  });

  clock.tick(500);
  expect(calls).toEqual([1_000, 500]);
  expect(unscheduled).toEqual([1_000, 500]);
  clock.tick(600);
  expect(calls).toEqual([1_000, 500, 600]);
  expect(unscheduled).toHaveLength(2);
});

test("manual refresh reschedules a display and destruction removes it", () => {
  const clock = new WallClock(1_000);
  const calls: number[] = [];
  let delay: number | null = null;
  const watch = clock.watch((nowMs) => {
    calls.push(nowMs);
    return delay === null ? null : nowMs + delay;
  });

  clock.tick(2_000);
  expect(calls).toEqual([1_000]);
  delay = 20;
  watch.refresh();
  expect(calls).toEqual([1_000, 2_000]);
  clock.tick(2_020);
  expect(calls).toEqual([1_000, 2_000, 2_020]);
  watch.destroy();
  watch.destroy();
  clock.tick(3_000);
  watch.refresh();
  expect(calls).toHaveLength(3);
});

test("callbacks can remove or register watches during a due batch", () => {
  const clock = new WallClock(0);
  const calls: string[] = [];
  let removed: WallClockWatch;
  clock.watch((nowMs) => {
    if (nowMs === 10) {
      removed.destroy();
      clock.watch(() => {
        calls.push("new");
        return null;
      });
      calls.push("first");
    }
    return 10;
  });
  removed = clock.watch((nowMs) => {
    if (nowMs === 10) calls.push("removed");
    return 10;
  });

  clock.tick(10);
  expect(calls).toEqual(["new", "first"]);
});

test("one failing display cannot block other updates", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const clock = new WallClock(0);
    const failure = new Error("display failed");
    const calls: number[] = [];
    clock.watch((nowMs) => {
      if (nowMs > 0) throw failure;
      return 10;
    });
    clock.watch((nowMs) => {
      calls.push(nowMs);
      return nowMs + 10;
    });

    clock.tick(10);
    clock.tick(20);
    expect(log).toHaveBeenCalledWith(
      "Wall-clock display update failed",
      failure,
    );
    expect(calls).toEqual([0, 10, 20]);
  } finally {
    log.mockRestore();
  }
});

test("market start text catches up across sleep and still schedules its next boundary", () => {
  const kickoff = 1_800_000_000_000;
  const clock = new WallClock(kickoff + 96 * 60_000);
  let text = "";
  let renders = 0;
  clock.watch((nowMs) => {
    const display = marketTimeDisplay(
      { kind: "game-start", timeMs: kickoff },
      nowMs,
    );
    text = display.text;
    renders++;
    return nowMs + Math.ceil(display.nextChangeMs!) + 1;
  });
  expect(text).toBe("started 1.6h ago");

  clock.tick(kickoff + 12 * 3_600_000);
  expect(text).toBe("started 12h ago");
  expect(renders).toBe(2);
  clock.tick(kickoff + 13 * 3_600_000 + 1);
  expect(text).toBe("started 13h ago");
  expect(renders).toBe(3);
});

test("the frame driver samples wall time, ignores animation time, and cleans up", () => {
  const clock = new WallClock(1_800_000_000_000);
  const calls: number[] = [];
  clock.watch((nowMs) => {
    calls.push(nowMs);
    return nowMs + 100;
  });
  let wallMs = clock.nowMs;
  let samples = 0;
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const stop = startWallClock(clock, {
    now: () => {
      samples++;
      return wallMs;
    },
    request: (callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
  });
  const frame = () => {
    expect(callbacks.size).toBe(1);
    const [id, callback] = [...callbacks.entries()][0]!;
    callbacks.delete(id);
    // A stalled/relative animation timestamp must not be used as epoch time.
    callback(8);
    expect(callbacks.size).toBe(1);
  };

  frame();
  expect(calls).toHaveLength(1);
  wallMs += 12 * 3_600_000;
  expect(calls).toHaveLength(1); // No frames while the tab is suspended.
  frame();
  expect(samples).toBe(2);
  expect(calls).toEqual([1_800_000_000_000, wallMs]);
  stop();
  expect(callbacks.size).toBe(0);
});
