import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";

test("bid and ask decimal boundaries share one exact coordinate", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: p(0.007), shares: 10 }], 1);
  memory.updateLevels("ask", [{ price: p(0.007), shares: 100 }], 2);

  expect(
    memory.priceBoundaries().filter((price) => price === p(0.007)),
  ).toEqual([p(0.007)]);
  const restored = new PressureFrontierMemory();
  expect(() => restored.restore(memory.snapshot())).not.toThrow();
  expect(restored.shellsAtPrice(p(0.008))[0]?.hiVolume).toBe(100);
});

test("unchanged observations advance only the current pressure timestamp", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 60 }], 2_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 60 }], 3_000);

  expect(memory.shellsAtPrice(p(0.4))).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: 1,
      validThroughMs: 3_000,
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      validThroughMs: 1_000,
    },
  ]);
});

test("successive shrink events preserve each last-valid boundary", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 60 }], 2_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 60 }], 3_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 30 }], 4_000);

  expect(memory.shellsAtPrice(p(0.4))).toEqual([
    {
      loVolume: 0,
      hiVolume: 30,
      side: 1,
      validThroughMs: 4_000,
    },
    {
      loVolume: 30,
      hiVolume: 60,
      side: 1,
      validThroughMs: 3_000,
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      validThroughMs: 1_000,
    },
  ]);
});

test("newer opposite-side observations permanently occlude older history", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.55), shares: 120 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.55), shares: 0 }], 2_000);
  memory.updateLevels("ask", [{ price: p(0.5), shares: 70 }], 3_000);
  memory.updateLevels("ask", [{ price: p(0.5), shares: 0 }], 4_000);

  expect(memory.shellsAtPrice(p(0.52))).toEqual([
    {
      loVolume: 0,
      hiVolume: 70,
      side: -1,
      validThroughMs: 3_000,
    },
    {
      loVolume: 70,
      hiVolume: 120,
      side: 1,
      validThroughMs: 1_000,
    },
  ]);
});

test("still-current hidden liquidity reappears when the newer side retreats", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.6), shares: 100 }], 1_000);
  memory.updateLevels("ask", [{ price: p(0.5), shares: 60 }], 2_000);

  expect(memory.shellsAtPrice(p(0.55))).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: -1,
      validThroughMs: 2_000,
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      validThroughMs: 2_000,
    },
  ]);

  memory.updateLevels("ask", [{ price: p(0.5), shares: 0 }], 3_000);
  expect(memory.shellsAtPrice(p(0.55))).toEqual([
    {
      loVolume: 0,
      hiVolume: 100,
      side: 1,
      validThroughMs: 3_000,
    },
  ]);
});

test("out-of-order source timestamps never move validity backward", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.5), shares: 100 }], 2_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 60 }], 1_500);

  expect(memory.shellsAtPrice(p(0.4))).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: 1,
      validThroughMs: 2_000,
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      validThroughMs: 2_000,
    },
  ]);
});

test("decimal updates preserve field totals through snapshot round trips", () => {
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
    const price = p((random() % 100) / 1000);
    const shares = step % 7 ? (random() % 1_000_000) / 100 : 0;
    const key = side === "ask" ? p(1 - price / 10_000) : price;
    if (shares > 0) levels[side].set(key, shares);
    else levels[side].delete(key);

    memory.updateLevels(side, [{ price, shares }], step);

    const snapshot = memory.snapshot();
    for (const run of snapshot.field.runs) {
      const bids = [...levels.bid].filter(([key]) => key >= run.hi);
      const asks = [...levels.ask].filter(([key]) => 10_000 - key <= run.lo);
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

test("large fractional removals cannot leave negative cumulative pressure", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("ask", [{ price: p(0.19), shares: 26_383_410.511 }], 1);
  memory.updateLevels("ask", [{ price: p(0.11), shares: 70_175_917.679 }], 2);
  memory.updateLevels("ask", [{ price: p(0.19), shares: 0 }], 3);
  memory.updateLevels("ask", [{ price: p(0.11), shares: 0 }], 4);

  expect(memory.currentLevels("ask")).toEqual([]);
  expect(memory.renderRuns().every((run) =>
    run.bands.every((band) => band.hiVolume > band.loVolume),
  )).toBe(true);
});

test("visibility depends only on timestamp and display half-life", () => {
  const memory = new PressureFrontierMemory();

  memory.updateLevels("bid", [{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.5), shares: 0 }], 2_000);

  const history = memory.shellsAtPrice(p(0.4));
  expect(memory.hasVisiblePressure(20_000, 1_000)).toBe(false);
  expect(memory.hasVisiblePressure(20_000, 100_000)).toBe(true);
  expect(memory.shellsAtPrice(p(0.4))).toEqual(history);
});
