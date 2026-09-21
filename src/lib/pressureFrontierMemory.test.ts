import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";

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
