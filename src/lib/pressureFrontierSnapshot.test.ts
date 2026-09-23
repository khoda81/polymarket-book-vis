import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import {
  parsePressureFrontierSnapshot,
  rebasePressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

test("failed restores preserve live pressure, ghosts, and subsequent updates", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels("bid", [{ price: 0.6, shares: 100 }], 1_000);
  memory.updateLevels("bid", [{ price: 0.6, shares: 60 }], 2_000);
  const before = memory.snapshot();
  if (before.version !== 2) throw new Error("Expected current snapshot format");
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

  memory.updateLevels("bid", [{ price: 0.6, shares: 40 }], 1_500);
  expect(memory.shellsAtPrice(0.5)).toEqual([
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
  source.updateLevels("bid", [{ price: 0.6, shares: 100 }], 1_000);
  source.updateLevels("bid", [{ price: 0.6, shares: 40 }], 2_000);
  source.updateLevels("ask", [{ price: 0.5, shares: 70 }], 3_000);
  source.updateLevels("ask", [{ price: 0.5, shares: 0 }], 4_000);

  const parsed = parsePressureFrontierSnapshot(
    JSON.parse(JSON.stringify(source.snapshot())),
  );
  const restored = new PressureFrontierMemory();
  restored.restore(parsed);

  for (const price of [0.1, 0.49, 0.55, 0.59, 0.8])
    expect(restored.shellsAtPrice(price)).toEqual(source.shellsAtPrice(price));
});

test("rebasing preserves ghost ages across clocks", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels("bid", [{ price: 0.5, shares: 50 }], 8_000);
  source.updateLevels("bid", [{ price: 0.5, shares: 0 }], 9_000);

  const rebased = rebasePressureFrontierSnapshot(
    source.snapshot(),
    10_000,
    100_000,
  );

  const restored = new PressureFrontierMemory();
  restored.restore(rebased);
  expect(restored.shellsAtPrice(0.4)).toEqual([
    {
      loVolume: 0,
      hiVolume: 50,
      side: 1,
      state: { kind: "ghost", sinceMs: 99_000 },
    },
  ]);
});
