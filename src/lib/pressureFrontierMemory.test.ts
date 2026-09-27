import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";

test("the two directed edges are independent", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges(
    [{ price: p(0.4), shares: 70 }],
    [{ price: p(0.3), shares: 120 }],
    1_000,
  );

  expect(memory.currentLevels("primaryToCollateral")).toEqual([
    { key: p(0.4), weight: 70 },
  ]);
  expect(memory.currentLevels("oppositeToCollateral")).toEqual([
    { key: p(0.3), weight: 120 },
  ]);

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.5))).toEqual([
    { loVolume: 0, hiVolume: 70, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice("oppositeToCollateral", p(0.5))).toEqual([
    { loVolume: 0, hiVolume: 120, validThroughMs: 1_000 },
  ]);
});

test("edge pressure is cumulative in edge-local price", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges(
    [
      { price: p(0.2), shares: 10 },
      { price: p(0.5), shares: 20 },
      { price: p(0.8), shares: 30 },
    ],
    [],
    1_000,
  );

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.1))).toEqual([]);
  expect(
    memory.bandsAtPrice("primaryToCollateral", p(0.3)).at(-1)?.hiVolume,
  ).toBe(10);
  expect(
    memory.bandsAtPrice("primaryToCollateral", p(0.6)).at(-1)?.hiVolume,
  ).toBe(30);
  expect(
    memory.bandsAtPrice("primaryToCollateral", p(0.9)).at(-1)?.hiVolume,
  ).toBe(60);
});

test("unchanged observations advance current pressure on both edges", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges(
    [{ price: p(0.5), shares: 100 }],
    [{ price: p(0.4), shares: 80 }],
    1_000,
  );
  memory.updateEdges([{ price: p(0.5), shares: 60 }], [], 2_000);
  memory.updateEdges([{ price: p(0.5), shares: 60 }], [], 3_000);

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 60, validThroughMs: 3_000 },
    { loVolume: 60, hiVolume: 100, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice("oppositeToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 80, validThroughMs: 3_000 },
  ]);
});

test("successive shrink events preserve each last-valid shell", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges([{ price: p(0.5), shares: 100 }], [], 1_000);
  memory.updateEdges([{ price: p(0.5), shares: 60 }], [], 2_000);
  memory.updateEdges([{ price: p(0.5), shares: 60 }], [], 3_000);
  memory.updateEdges([{ price: p(0.5), shares: 30 }], [], 4_000);

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 30, validThroughMs: 4_000 },
    { loVolume: 30, hiVolume: 60, validThroughMs: 3_000 },
    { loVolume: 60, hiVolume: 100, validThroughMs: 1_000 },
  ]);
});

test("history on one token edge never occludes the other", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges([{ price: p(0.5), shares: 120 }], [], 1_000);
  memory.updateEdges([{ price: p(0.5), shares: 0 }], [], 2_000);
  memory.updateEdges([], [{ price: p(0.5), shares: 70 }], 3_000);
  memory.updateEdges([], [{ price: p(0.5), shares: 0 }], 4_000);

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 120, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice("oppositeToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 70, validThroughMs: 3_000 },
  ]);
});

test("both fields stay rooted at volume zero", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges(
    [{ price: p(0.5), shares: 60 }],
    [{ price: p(0.4), shares: 100 }],
    1_000,
  );

  for (const edge of ["primaryToCollateral", "oppositeToCollateral"] as const) {
    const runs = memory.renderRuns(edge).filter((run) => run.bands.length > 0);
    expect(
      runs.every((run) => run.bands.every((band) => band.loVolume === 0)),
    ).toBe(true);
  }
});

test("out-of-order source timestamps never move validity backward", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges([{ price: p(0.5), shares: 100 }], [], 2_000);
  memory.updateEdges([{ price: p(0.5), shares: 60 }], [], 1_500);

  expect(memory.bandsAtPrice("primaryToCollateral", p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 100, validThroughMs: 2_000 },
  ]);
});

test("snapshot round trips preserve exact edge-local pressure", () => {
  const memory = new PressureFrontierMemory();
  memory.updateEdges(
    [
      { price: p(0.2), shares: 10.25 },
      { price: p(0.6), shares: 30.5 },
    ],
    [
      { price: p(0.3), shares: 12.75 },
      { price: p(0.7), shares: 42.125 },
    ],
    1_000,
  );
  memory.updateEdges(
    [{ price: p(0.6), shares: 5.5 }],
    [{ price: p(0.3), shares: 0 }],
    2_000,
  );

  const restored = new PressureFrontierMemory();
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())));

  for (const edge of ["primaryToCollateral", "oppositeToCollateral"] as const)
    for (const price of [0.1, 0.25, 0.5, 0.8].map(p))
      expect(restored.bandsAtPrice(edge, price)).toEqual(
        memory.bandsAtPrice(edge, price),
      );
});

test("visibility depends only on timestamps and display half-life", () => {
  const memory = new PressureFrontierMemory();

  memory.updateEdges([{ price: p(0.5), shares: 100 }], [], 1_000);
  memory.updateEdges([{ price: p(0.5), shares: 0 }], [], 2_000);

  const history = memory.bandsAtPrice("primaryToCollateral", p(0.6));
  expect(memory.hasVisiblePressure(20_000, 1_000)).toBe(false);
  expect(memory.hasVisiblePressure(20_000, 100_000)).toBe(true);
  expect(memory.bandsAtPrice("primaryToCollateral", p(0.6))).toEqual(history);
});
