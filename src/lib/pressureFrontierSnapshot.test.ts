import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";
import {
  parsePressureFrontierSnapshot,
  rebasePressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

test("failed restores preserve live pressure, ghosts, and subsequent updates", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: p(0.6), shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: p(0.6), shares: 60 }], 2_000);
  const before = memory.snapshot();
  if (before.version !== 3) throw new Error("Expected current snapshot format");
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

  memory.updateLevels("bid", [{ price: p(0.6), shares: 40 }], 1_500);
  expect(memory.shellsAtPrice(p(0.5))).toEqual([
    { loVolume: 0, hiVolume: 40, side: 1, state: { kind: "live" } },
    {
      loVolume: 40,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("frontier snapshot round trip preserves visible shells", () => {
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

test("rebasing preserves ghost ages across clocks", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("bid", [{ price: p(0.5), shares: 50 }], 8_000);
  source.updateLevels("bid", [{ price: p(0.5), shares: 0 }], 9_000);

  const rebased = rebasePressureFrontierSnapshot(
    source.snapshot(),
    10_000,
    100_000,
  );

  const restored = new PressureFrontierMemory();
  restored.restore(rebased);
  expect(restored.shellsAtPrice(p(0.4))).toEqual([
    {
      loVolume: 0,
      hiVolume: 50,
      side: 1,
      state: { kind: "ghost", sinceMs: 99_000 },
    },
  ]);
});

test("version 3 persists price coordinates as scaled integers", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("ask", [{ price: p(0.013), shares: 25 }], 1);
  const snapshot = memory.snapshot();

  expect(snapshot.version).toBe(3);
  expect(snapshot.ask.current[0]?.key).toBe(p(0.987));
  expect(snapshot.field.runs.every((run) => Number.isInteger(run.lo))).toBe(
    true,
  );
});

test("legacy float snapshots canonicalize reciprocal rounding noise", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("ask", [{ price: p(0.013), shares: 25 }], 1);
  const current = source.snapshot();
  const legacy = {
    version: 2,
    bid: {
      current: current.bid.current.map((level) => ({
        ...level,
        key: level.key / 10_000,
      })),
    },
    ask: {
      current: current.ask.current.map((level) => ({
        ...level,
        key: level.key / 10_000 + Number.EPSILON,
      })),
    },
    field: {
      ...current.field,
      runs: current.field.runs.map((run) => ({
        ...run,
        lo: run.lo / 10_000 - (run.lo === p(0.013) ? Number.EPSILON : 0),
        hi: run.hi / 10_000 - (run.hi === p(0.013) ? Number.EPSILON : 0),
      })),
    },
  };

  const restored = new PressureFrontierMemory();
  expect(() => restored.restore(legacy)).not.toThrow();
  expect(restored.currentLevels("ask")).toEqual(source.currentLevels("ask"));
  expect(restored.shellsAtPrice(p(0.013))[0]?.hiVolume).toBe(25);
});

test("restore rejects a materialized field missing a live price boundary", () => {
  const malformed = {
    version: 3,
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
