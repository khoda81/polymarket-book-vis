import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";

test("pressure is cumulative in token-local price", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels(
    [
      { price: p(0.2), shares: 10 },
      { price: p(0.5), shares: 20 },
      { price: p(0.8), shares: 30 },
    ],
    1_000,
  );

  expect(memory.bandsAtPrice(p(0.1))).toEqual([]);
  expect(memory.bandsAtPrice(p(0.3)).at(-1)?.hiVolume).toBe(10);
  expect(memory.bandsAtPrice(p(0.6)).at(-1)?.hiVolume).toBe(30);
  expect(memory.bandsAtPrice(p(0.9)).at(-1)?.hiVolume).toBe(60);
});

test("unchanged observations advance current pressure timestamp", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 3_000);

  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 60, validThroughMs: 3_000 },
    { loVolume: 60, hiVolume: 100, validThroughMs: 1_000 },
  ]);
});

test("successive shrink events preserve last-valid shells", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 3_000);
  memory.updateLevels([{ price: p(0.5), shares: 30 }], 4_000);

  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 30, validThroughMs: 4_000 },
    { loVolume: 30, hiVolume: 60, validThroughMs: 3_000 },
    { loVolume: 60, hiVolume: 100, validThroughMs: 1_000 },
  ]);
});

test("out-of-order timestamps never move validity backward", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 1_500);

  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 100, validThroughMs: 2_000 },
  ]);
});

test("snapshot round trip preserves exact pressure", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels(
    [
      { price: p(0.2), shares: 10.25 },
      { price: p(0.6), shares: 30.5 },
    ],
    1_000,
  );
  memory.updateLevels([{ price: p(0.6), shares: 5.5 }], 2_000);

  const restored = new PressureFrontierMemory();
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())));

  for (const price of [0.1, 0.25, 0.5, 0.8].map(p))
    expect(restored.bandsAtPrice(price)).toEqual(memory.bandsAtPrice(price));
});

test("visibility depends only on timestamps and half-life", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 0 }], 2_000);

  const history = memory.bandsAtPrice(p(0.6));
  expect(memory.hasVisiblePressure(20_000, 1_000)).toBe(false);
  expect(memory.hasVisiblePressure(20_000, 100_000)).toBe(true);
  expect(memory.bandsAtPrice(p(0.6))).toEqual(history);
});

test("render view keeps stored bands stable while current validity advances separately", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);

  const runs = memory.renderRuns();
  const active = runs.find((run) => run.volume === 100);
  expect(active?.frozenBands).toEqual([]);

  // Same book, newer observation: no historical bands should be cloned or
  // rewritten just to advance the current surface's validity.
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 3_000);

  expect(memory.renderRuns()).toBe(runs);
  expect(active?.frozenBands).toEqual([]);
  expect(memory.renderCurrentValidThroughMs()).toBe(3_000);

  // Materialized/query semantics are unchanged for non-render consumers.
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 100, validThroughMs: 3_000 },
  ]);
});

test("render data revision changes only when pressure geometry changes", () => {
  const memory = new PressureFrontierMemory();

  expect(memory.renderDataRevision()).toBe(0);

  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  expect(memory.renderDataRevision()).toBe(1);

  // A newer observation refreshes current validity but leaves resident geometry
  // unchanged, so the GPU buffer can be reused.
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 2_000);
  expect(memory.renderDataRevision()).toBe(1);

  memory.updateLevels([{ price: p(0.5), shares: 80 }], 3_000);
  expect(memory.renderDataRevision()).toBe(2);
});

test("pressure boundaries exclude the implicit disposal sentinel", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels(
    [
      { price: p(0), shares: 123 },
      { price: p(0.2), shares: 10 },
      { price: p(0.5), shares: 20 },
      { price: p(1), shares: 30 },
    ],
    1_000,
  );

  expect(memory.currentLevels()).toEqual([
    { key: p(0.2), weight: 10 },
    { key: p(0.5), weight: 20 },
    { key: p(1), weight: 30 },
  ]);
  expect(memory.priceBoundaries()).toEqual([p(0.2), p(0.5), p(1)]);
  expect(memory.bandsAtPrice(p(0))).toEqual([]);
  expect(memory.bandsAtPrice(p(1)).at(-1)?.hiVolume).toBe(60);
});

test("frontier stack forgets history that becomes current again", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 30 }], 3_000);

  expect(memory.renderRuns()[0]?.frozenBands).toEqual([
    { loVolume: 60, hiVolume: 100, validThroughMs: 1_000 },
    { loVolume: 30, hiVolume: 60, validThroughMs: 2_000 },
  ]);

  memory.updateLevels([{ price: p(0.5), shares: 80 }], 4_000);

  expect(memory.renderRuns()[0]?.frozenBands).toEqual([
    { loVolume: 80, hiVolume: 100, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 80, validThroughMs: 4_000 },
    { loVolume: 80, hiVolume: 100, validThroughMs: 1_000 },
  ]);
});

test("snapshot stores current pressure implicitly", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);

  expect(memory.snapshot().field).toEqual({
    maxPrice: p(1),
    currentValidThroughMs: 2_000,
    runs: [
      {
        price: p(0.5),
        volume: 60,
        frozenBands: [{ loVolume: 60, hiVolume: 100, validThroughMs: 1_000 }],
      },
    ],
  });
});

test("pressure updates report whether persisted state changed", () => {
  const memory = new PressureFrontierMemory();

  expect(memory.updateLevels([], 1_000)).toBe(false);
  expect(memory.updateLevels([{ price: p(0), shares: 10 }], 1_000)).toBe(false);

  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000)).toBe(true);
  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000)).toBe(false);
  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 2_000)).toBe(true);

  expect(memory.observeLevels([{ key: p(0.5), weight: 10 }], 2_000)).toBe(false);
  expect(memory.observeLevels([{ key: p(0.5), weight: 10 }], 3_000)).toBe(true);
});
