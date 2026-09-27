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
