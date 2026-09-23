import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";

test("mirrored decimal boundaries round-trip without phantom ask pressure", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: 0.007, shares: 10 }], 1);
  memory.updateLevels("ask", [{ price: 0.007, shares: 100 }], 2);

  // Mirroring creates a distinct boundary at 0.007000000000000006.
  // There must be no pressure in the tiny interval between the two levels.
  const gap = memory.renderRuns().find((run) => run.lo === 0.007);
  expect(gap?.hi).toBe(1 - (1 - 0.007));
  expect(gap?.bands).toEqual([]);
  const restored = new PressureFrontierMemory();
  expect(() => restored.restore(memory.snapshot())).not.toThrow();
  expect(restored.shellsAtPrice(0.008)[0]?.hiVolume).toBe(100);
});

test("adjacent floating-point share amounts keep the entire live shell", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: 0.5, shares: 0.3 }], 1);
  memory.updateLevels("bid", [{ price: 0.5, shares: 0.1 + 0.2 }], 2);

  expect(memory.shellsAtPrice(0.4)).toEqual([
    { loVolume: 0, hiVolume: 0.1 + 0.2, side: 1, state: { kind: "live" } },
  ]);
  expect(() =>
    new PressureFrontierMemory().restore(memory.snapshot()),
  ).not.toThrow();
});

test("decimal level updates preserve field totals through snapshot round trips", () => {
  const memory = new PressureFrontierMemory();
  const levels = {
    bid: new Map<number, number>(),
    ask: new Map<number, number>(),
  };
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };

  for (let step = 0; step < 250; step++) {
    const side = step % 2 ? "ask" : "bid";
    const price = (random() % 100) / 1000;
    const shares = step % 7 ? (random() % 1_000_000) / 100 : 0;
    const key = side === "ask" ? 1 - price : price;
    if (shares > 0) levels[side].set(key, shares);
    else levels[side].delete(key);
    memory.updateLevels(side, [{ price, shares }], step);
    const snapshot = memory.snapshot();
    if (snapshot.version !== 2)
      throw new Error("Expected current snapshot format");

    // Independent flat-book oracle, including the tiny intervals that have
    // no representable interior sample. No tree or renderer queries here.
    for (const run of snapshot.field.runs) {
      const bids = [...levels.bid].filter(([key]) => key >= run.hi);
      const asks = [...levels.ask].filter(([key]) => 1 - key <= run.lo);
      expect(run.bidVolume).toBeCloseTo(
        bids.reduce((sum, [, size]) => sum + size, 0),
        7,
      );
      expect(run.askVolume).toBeCloseTo(
        asks.reduce((sum, [, size]) => sum + size, 0),
        7,
      );
    }
    expect(() => new PressureFrontierMemory().restore(snapshot)).not.toThrow();
  }
});

test("decreasing a level creates exactly the uncovered ghost shell", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.5, shares: 60 }], 2_000);

  expect(memory.shellsAtPrice(0.4)).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("increasing pressure overwrites history instead of creating another layer", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.5, shares: 40 }], 2_000);
  expect(memory.historyDepth("bid")).toBe(1);

  memory.updateLevels("bid", [{ price: 0.5, shares: 80 }], 3_000);
  expect(memory.historyDepth("bid")).toBe(1);
  expect(memory.shellsAtPrice(0.4)).toEqual([
    {
      loVolume: 0,
      hiVolume: 80,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 80,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("older outer ghosts survive newer inner shrink events", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.5, shares: 60 }], 2_000);
  memory.updateLevels("bid", [{ price: 0.5, shares: 30 }], 3_000);

  expect(memory.shellsAtPrice(0.4)).toEqual([
    {
      loVolume: 0,
      hiVolume: 30,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 30,
      hiVolume: 60,
      side: 1,
      state: { kind: "ghost", sinceMs: 3_000 },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("newer opposite-side history owns overlap in the spread", () => {
  const memory = new PressureFrontierMemory();

  // Bid once reached this price with 120 shares, then disappeared.
  memory.updateLevels("bid", [{ price: 0.55, shares: 120 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.55, shares: 0 }], 2_000);

  // Later the ask moved through the same price with 70 shares and disappeared.
  memory.updateLevels("ask", [{ price: 0.5, shares: 70 }], 3_000);
  memory.updateLevels("ask", [{ price: 0.5, shares: 0 }], 4_000);

  expect(memory.shellsAtPrice(0.52)).toEqual([
    {
      loVolume: 0,
      hiVolume: 70,
      side: -1,
      state: { kind: "ghost", sinceMs: 4_000 },
    },
    {
      loVolume: 70,
      hiVolume: 120,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("a newer larger opposite-side excursion permanently occludes older history", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.55, shares: 120 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.55, shares: 0 }], 2_000);

  memory.updateLevels("ask", [{ price: 0.5, shares: 150 }], 3_000);
  memory.updateLevels("ask", [{ price: 0.5, shares: 0 }], 4_000);

  expect(memory.shellsAtPrice(0.52)).toEqual([
    {
      loVolume: 0,
      hiVolume: 150,
      side: -1,
      state: { kind: "ghost", sinceMs: 4_000 },
    },
  ]);
});

test("one price-level atom affects only its monotone side-local prefix", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels(
    "bid",
    [
      { price: 0.3, shares: 10 },
      { price: 0.7, shares: 20 },
    ],
    1_000,
  );

  expect(memory.shellsAtPrice(0.2)[0]?.hiVolume).toBe(30);
  expect(memory.shellsAtPrice(0.5)[0]?.hiVolume).toBe(20);
  expect(memory.shellsAtPrice(0.8)).toEqual([]);
});

test("same-timestamp batch uses final absolute level sizes", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 1_000);
  memory.updateLevels(
    "bid",
    [
      { price: 0.5, shares: 20 },
      { price: 0.5, shares: 120 },
    ],
    2_000,
  );

  expect(memory.historyDepth("bid")).toBe(0);
  expect(memory.shellsAtPrice(0.4)[0]?.hiVolume).toBe(120);
});

test("removing large fractional ask levels cannot leave negative cumulative pressure", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("ask", [{ price: 0.19, shares: 26_383_410.511 }], 1);
  memory.updateLevels("ask", [{ price: 0.11, shares: 70_175_917.679 }], 2);
  memory.updateLevels("ask", [{ price: 0.19, shares: 0 }], 3);
  memory.updateLevels("ask", [{ price: 0.11, shares: 0 }], 4);

  expect(memory.currentLevels("ask")).toEqual([]);
  expect(
    memory
      .renderRuns()
      .every((run) => run.bands.every((band) => band.state.kind === "ghost")),
  ).toBe(true);
});

test("render runs are stable between draws and invalidate only on mutation", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels(
    "bid",
    [
      { price: 0.4, shares: 10 },
      { price: 0.6, shares: 20 },
    ],
    1_000,
  );

  const first = memory.renderRuns();
  const second = memory.renderRuns();
  expect(second).toBe(first);

  memory.updateLevels("bid", [{ price: 0.6, shares: 15 }], 2_000);
  const third = memory.renderRuns();

  expect(third).not.toBe(first);
  expect(
    third
      .filter((run) => run.bands.length > 0)
      .map(({ lo, hi, bands }) => ({ lo, hi, bands })),
  ).toEqual([
    {
      lo: 0,
      hi: 0.4,
      bands: [
        {
          loVolume: 0,
          hiVolume: 25,
          side: 1,
          state: { kind: "live" },
        },
        {
          loVolume: 25,
          hiVolume: 30,
          side: 1,
          state: { kind: "ghost", sinceMs: 2_000 },
        },
      ],
    },
    {
      lo: 0.4,
      hi: 0.6,
      bands: [
        {
          loVolume: 0,
          hiVolume: 15,
          side: 1,
          state: { kind: "live" },
        },
        {
          loVolume: 15,
          hiVolume: 20,
          side: 1,
          state: { kind: "ghost", sinceMs: 2_000 },
        },
      ],
    },
  ]);
});

test("render runs merge adjacent price intervals with identical shell stacks", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.8, shares: 20 }], 1_000);
  memory.updateLevels("ask", [{ price: 0.2, shares: 10 }], 2_000);
  memory.updateLevels("ask", [{ price: 0.2, shares: 0 }], 3_000);

  const runs = memory.renderRuns();
  expect(runs.every((run) => run.hi > run.lo)).toBe(true);
  expect(memory.renderRuns()).toBe(runs);
});

test("out-of-order external timestamps preserve observation order", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 2_000);
  expect(() =>
    memory.updateLevels("bid", [{ price: 0.5, shares: 60 }], 1_500),
  ).not.toThrow();

  expect(memory.shellsAtPrice(0.4)).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("still-live hidden liquidity reappears when the newer side retreats", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.6, shares: 100 }], 1_000);
  memory.updateLevels("ask", [{ price: 0.5, shares: 60 }], 2_000);

  expect(memory.shellsAtPrice(0.55)).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: -1,
      state: { kind: "live" },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "live" },
    },
  ]);

  memory.updateLevels("ask", [{ price: 0.5, shares: 0 }], 3_000);
  expect(memory.shellsAtPrice(0.55)).toEqual([
    {
      loVolume: 0,
      hiVolume: 100,
      side: 1,
      state: { kind: "live" },
    },
  ]);
});

test("overwritten historical liquidity never resurrects", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.6, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.6, shares: 0 }], 2_000);
  memory.updateLevels("ask", [{ price: 0.5, shares: 60 }], 3_000);
  memory.updateLevels("ask", [{ price: 0.5, shares: 0 }], 4_000);

  expect(memory.shellsAtPrice(0.55)).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: -1,
      state: { kind: "ghost", sinceMs: 4_000 },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("ghost visibility is reversible when the display half-life changes", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: 0.5, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.5, shares: 0 }], 2_000);

  const history = memory.shellsAtPrice(0.4);
  expect(memory.hasVisibleGhosts(20_000, 1_000)).toBe(false);
  expect(memory.hasVisibleGhosts(20_000, 100_000)).toBe(true);
  expect(memory.shellsAtPrice(0.4)).toEqual(history);
});
