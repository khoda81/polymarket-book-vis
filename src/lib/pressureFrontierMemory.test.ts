import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";

test("pressure cumulative volume is derived from exact run shares", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels(
    [
      { price: p(0.1), shares: 20 },
      { price: p(0.3), shares: 35 },
    ],
    1_000,
  );

  expect(memory.currentLevels()).toEqual([
    { price: p(0.1), shares: 20 },
    { price: p(0.3), shares: 35 },
  ]);
  expect(memory.bandsAtPrice(p(0.1)).at(-1)?.hiVolume).toBe(20);
  expect(memory.bandsAtPrice(p(0.2)).at(-1)?.hiVolume).toBe(20);
  expect(memory.bandsAtPrice(p(0.3)).at(-1)?.hiVolume).toBe(55);
});

test("10 -> 4 -> 8 -> 12 freezes, trims, then submerges history", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 4 }], 2_000);

  expect(memory.renderRuns()[0]).toEqual({
    price: p(0.5),
    shares: 4,
    frozenSteps: [{ hiVolume: 10, validThroughMs: 1_000 }],
  });
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 4, validThroughMs: 2_000 },
    { loVolume: 4, hiVolume: 10, validThroughMs: 1_000 },
  ]);

  memory.updateLevels([{ price: p(0.5), shares: 8 }], 3_000);
  expect(memory.renderRuns()[0]?.frozenSteps).toEqual([
    { hiVolume: 10, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 8, validThroughMs: 3_000 },
    { loVolume: 8, hiVolume: 10, validThroughMs: 1_000 },
  ]);

  memory.updateLevels([{ price: p(0.5), shares: 12 }], 4_000);
  expect(memory.renderRuns()[0]?.frozenSteps).toEqual([]);
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 12, validThroughMs: 4_000 },
  ]);
});

test("same validity decreases coalesce while distinct validity creates steps", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 8 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 6 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 4 }], 2_000);

  expect(memory.renderRuns()[0]?.frozenSteps).toEqual([
    { hiVolume: 10, validThroughMs: 1_000 },
    { hiVolume: 8, validThroughMs: 2_000 },
  ]);

  memory.observeThrough(3_000);
  memory.updateLevels([{ price: p(0.5), shares: 2 }], 4_000);

  expect(memory.renderRuns()[0]?.frozenSteps).toEqual([
    { hiVolume: 10, validThroughMs: 1_000 },
    { hiVolume: 8, validThroughMs: 2_000 },
    { hiVolume: 4, validThroughMs: 3_000 },
  ]);
});

test("unchanged observations advance validity without rewriting geometry", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);

  const runs = memory.renderRuns();
  expect(memory.observeThrough(2_500)).toBe(true);
  expect(memory.renderRuns()).toBe(runs);
  expect(memory.renderDataRevision()).toBe(1);
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 100, validThroughMs: 2_500 },
  ]);

  expect(memory.observeThrough(2_000)).toBe(false);
  expect(memory.renderRuns()).toBe(runs);
});

test("out-of-order timestamps never move validity backward", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 1_500);

  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 100, validThroughMs: 2_000 },
  ]);
});

test("price-boundary splitting copies the canonical history stack", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.2), shares: 10 }], 1_000);
  memory.updateLevels([{ price: p(0.2), shares: 5 }], 2_000);
  memory.updateLevels([{ price: p(0.5), shares: 2 }], 3_000);

  expect(memory.renderRuns()).toEqual([
    {
      price: p(0.2),
      shares: 5,
      frozenSteps: [{ hiVolume: 10, validThroughMs: 1_000 }],
    },
    {
      price: p(0.5),
      shares: 2,
      frozenSteps: [{ hiVolume: 10, validThroughMs: 1_000 }],
    },
  ]);
  expect(memory.bandsAtPrice(p(0.3))).toEqual([
    { loVolume: 0, hiVolume: 5, validThroughMs: 3_000 },
    { loVolume: 5, hiVolume: 10, validThroughMs: 1_000 },
  ]);
  expect(memory.bandsAtPrice(p(0.6))).toEqual([
    { loVolume: 0, hiVolume: 7, validThroughMs: 3_000 },
    { loVolume: 7, hiVolume: 10, validThroughMs: 1_000 },
  ]);
});

test("adjacent identical runs merge after history is submerged", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels(
    [
      { price: p(0.2), shares: 10 },
      { price: p(0.5), shares: 5 },
    ],
    1_000,
  );
  memory.updateLevels([{ price: p(0.5), shares: 0 }], 2_000);
  expect(memory.priceBoundaries()).toEqual([p(0.2), p(0.5)]);

  memory.updateLevels([{ price: p(0.2), shares: 15 }], 3_000);
  expect(memory.priceBoundaries()).toEqual([p(0.2)]);
  expect(memory.renderRuns()).toEqual([
    { price: p(0.2), shares: 15, frozenSteps: [] },
  ]);
});

test("band hit testing reconstructs current and frozen upper boundaries", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);

  expect(memory.bandAtPoint(p(0.6), 30)).toEqual({
    loVolume: 0,
    hiVolume: 60,
    validThroughMs: 2_000,
  });
  expect(memory.bandAtPoint(p(0.6), 70)).toEqual({
    loVolume: 60,
    hiVolume: 100,
    validThroughMs: 1_000,
  });
  expect(memory.bandAtPoint(p(0.6), 100)).toBeUndefined();
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

test("snapshot stores shares and steps without redundant geometry", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 60 }], 2_000);

  expect(memory.snapshot()).toEqual({
    version: 6,
    state: {
      kind: "observed",
      validThroughMs: 2_000,
      runs: [
        {
          price: p(0.5),
          shares: 60,
          frozenSteps: [{ hiVolume: 100, validThroughMs: 1_000 }],
        },
      ],
    },
  });

  const serialized = JSON.stringify(memory.snapshot());
  expect(serialized).not.toContain("loVolume");
  expect(serialized).not.toContain('"volume":');
  expect(serialized).not.toContain('"current":');
  expect(serialized).not.toContain("frozenBands");
});

test("visibility depends only on canonical current and step timestamps", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.5), shares: 0 }], 2_000);

  const history = memory.bandsAtPrice(p(0.6));
  expect(memory.hasVisiblePressure(20_000, 1_000)).toBe(false);
  expect(memory.hasVisiblePressure(20_000, 100_000)).toBe(true);
  expect(memory.bandsAtPrice(p(0.6))).toEqual(history);
});

test("render revision changes only when pressure geometry changes", () => {
  const memory = new PressureFrontierMemory();

  expect(memory.renderDataRevision()).toBe(0);
  memory.updateLevels([{ price: p(0.5), shares: 100 }], 1_000);
  expect(memory.renderDataRevision()).toBe(1);
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
    { price: p(0.2), shares: 10 },
    { price: p(0.5), shares: 20 },
    { price: p(1), shares: 30 },
  ]);
  expect(memory.priceBoundaries()).toEqual([p(0.2), p(0.5), p(1)]);
  expect(memory.bandsAtPrice(p(0))).toEqual([]);
  expect(memory.bandsAtPrice(p(1)).at(-1)?.hiVolume).toBe(60);
});

test("pressure updates report whether canonical state changed", () => {
  const memory = new PressureFrontierMemory();

  expect(memory.updateLevels([], 1_000)).toBe(false);
  expect(memory.updateLevels([{ price: p(0), shares: 10 }], 1_000)).toBe(false);

  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000)).toBe(true);
  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 1_000)).toBe(false);
  expect(memory.updateLevels([{ price: p(0.5), shares: 10 }], 2_000)).toBe(true);

  expect(memory.observeLevels([{ price: p(0.5), shares: 10 }], 2_000)).toBe(false);
  expect(memory.observeLevels([{ price: p(0.5), shares: 10 }], 3_000)).toBe(true);
});
