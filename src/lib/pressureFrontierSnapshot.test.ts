import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";
import {
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  parsePressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

test("failed restores preserve existing pressure", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.6), shares: 100 }], 1_000);
  memory.updateLevels([{ price: p(0.6), shares: 60 }], 2_000);
  const before = memory.snapshot();

  const invalid = {
    ...before,
    current: [],
  };

  expect(() => memory.restore(invalid)).toThrow();
  expect(memory.snapshot()).toEqual(before);
});

test("snapshot round trip preserves token-local history", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels([{ price: p(0.4), shares: 100 }], 1_000);
  source.updateLevels([{ price: p(0.4), shares: 40 }], 2_000);

  const parsed = parsePressureFrontierSnapshot(
    JSON.parse(JSON.stringify(source.snapshot())),
  );
  const restored = new PressureFrontierMemory();
  restored.restore(parsed);

  for (const price of [0.1, 0.35, 0.5, 0.8].map(p))
    expect(restored.bandsAtPrice(price)).toEqual(source.bandsAtPrice(price));
});

test("snapshot persists exact token-local coordinates", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.013), shares: 25 }], 1);
  const snapshot = memory.snapshot();

  expect(snapshot.version).toBe(PRESSURE_FRONTIER_SNAPSHOT_VERSION);
  expect(snapshot.current[0]?.key).toBe(p(0.013));
  expect(snapshot.field.runs.every((run) => Number.isInteger(run.lo))).toBe(
    true,
  );
});

test("older snapshot versions are rejected by the canonical parser", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: 3,
      primaryToCollateral: { current: [], field: {} },
    }),
  ).toThrow(/unsupported pressure frontier snapshot version/);
});
