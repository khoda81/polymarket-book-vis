import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";
import { parsePressureFrontierSnapshot } from "./pressureFrontierSnapshot";

test("failed restores preserve existing pressure state", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: p(0.6), shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.6), shares: 60 }], 2_000);
  const before = memory.snapshot();

  const invalidField = {
    ...before,
    field: {
      ...before.field,
      runs: before.field.runs.map((run) => ({ ...run, bidVolume: 1_000 })),
    },
  };
  const invalidFrontier = { ...before, bid: { current: [] } };

  for (const invalid of [invalidField, invalidFrontier]) {
    expect(() => memory.restore(invalid)).toThrow();
    expect(memory.snapshot()).toEqual(before);
  }
});

test("snapshot round trip preserves timestamped pressure", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("bid", [{ price: p(0.6), shares: 100 }], 1_000);
  source.updateLevels("bid", [{ price: p(0.6), shares: 40 }], 2_000);
  source.updateLevels("ask", [{ price: p(0.5), shares: 70 }], 3_000);
  source.updateLevels("ask", [{ price: p(0.5), shares: 0 }], 4_000);

  const parsed = parsePressureFrontierSnapshot(
    JSON.parse(JSON.stringify(source.snapshot())),
  );
  const restored = new PressureFrontierMemory();
  restored.restore(parsed);

  for (const price of [0.1, 0.49, 0.55, 0.59, 0.8].map(p))
    expect(restored.shellsAtPrice(price)).toEqual(source.shellsAtPrice(price));
});

test("snapshot persists exact scaled price coordinates", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("ask", [{ price: p(0.013), shares: 25 }], 1);
  const snapshot = memory.snapshot();

  expect(snapshot.ask.current[0]?.key).toBe(p(0.987));
  expect(snapshot.field.runs.every((run) => Number.isInteger(run.lo))).toBe(
    true,
  );
});

test("restore rejects a materialized field missing a current price boundary", () => {
  const malformed = {
    bid: { current: [{ key: p(0.5), weight: 100 }] },
    ask: { current: [] },
    field: {
      revision: 0,
      runs: [
        {
          lo: p(0),
          hi: p(1),
          bidVolume: 0,
          askVolume: 0,
          bidRevision: 0,
          askRevision: 0,
          bands: [],
        },
      ],
    },
  };

  expect(() => new PressureFrontierMemory().restore(malformed)).toThrow(
    /missing a bid frontier boundary/,
  );
});
