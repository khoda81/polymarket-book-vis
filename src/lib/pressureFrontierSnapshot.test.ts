import { expect, test } from "bun:test";
import { PressureFrontierMemory } from "./pressureFrontierMemory";
import { priceFromLegacyNumber as p } from "./price";
import {
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  parsePressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

test("failed restores preserve existing edge pressure state", () => {
  const memory = new PressureFrontierMemory();
  memory.updateEdges([{ price: p(0.6), shares: 100 }], [], 1_000);
  memory.updateEdges([{ price: p(0.6), shares: 60 }], [], 2_000);
  const before = memory.snapshot();

  const invalidField = {
    ...before,
    primaryToCollateral: {
      ...before.primaryToCollateral,
      field: {
        ...before.primaryToCollateral.field,
        runs: before.primaryToCollateral.field.runs.map((run) => ({
          ...run,
          volume: 1_000,
        })),
      },
    },
  };
  const invalidFrontier = {
    ...before,
    primaryToCollateral: {
      ...before.primaryToCollateral,
      current: [],
    },
  };

  for (const invalid of [invalidField, invalidFrontier]) {
    expect(() => memory.restore(invalid)).toThrow();
    expect(memory.snapshot()).toEqual(before);
  }
});

test("snapshot round trip preserves both directed edge fields", () => {
  const source = new PressureFrontierMemory();
  source.updateEdges(
    [{ price: p(0.4), shares: 100 }],
    [{ price: p(0.3), shares: 70 }],
    1_000,
  );
  source.updateEdges(
    [{ price: p(0.4), shares: 40 }],
    [{ price: p(0.3), shares: 0 }],
    2_000,
  );

  const parsed = parsePressureFrontierSnapshot(
    JSON.parse(JSON.stringify(source.snapshot())),
  );
  const restored = new PressureFrontierMemory();
  restored.restore(parsed);

  for (const edge of ["primaryToCollateral", "oppositeToCollateral"] as const)
    for (const price of [0.1, 0.35, 0.5, 0.8].map(p))
      expect(restored.bandsAtPrice(edge, price)).toEqual(
        source.bandsAtPrice(edge, price),
      );
});

test("snapshot persists exact edge-local price coordinates", () => {
  const memory = new PressureFrontierMemory();
  memory.updateEdges([{ price: p(0.013), shares: 25 }], [], 1);
  const snapshot = memory.snapshot();

  expect(snapshot.version).toBe(PRESSURE_FRONTIER_SNAPSHOT_VERSION);
  expect(snapshot.primaryToCollateral.current[0]?.key).toBe(p(0.013));
  expect(
    snapshot.primaryToCollateral.field.runs.every((run) =>
      Number.isInteger(run.lo),
    ),
  ).toBe(true);
});

test("restore rejects a field missing its current frontier boundary", () => {
  const malformed = {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    primaryToCollateral: {
      current: [{ key: p(0.5), weight: 100 }],
      field: {
        currentValidThroughMs: null,
        runs: [
          {
            lo: p(0),
            hi: p(1),
            volume: 0,
            bands: [],
          },
        ],
      },
    },
    oppositeToCollateral: {
      current: [],
      field: {
        currentValidThroughMs: null,
        runs: [
          {
            lo: p(0),
            hi: p(1),
            volume: 0,
            bands: [],
          },
        ],
      },
    },
  };

  expect(() => new PressureFrontierMemory().restore(malformed)).toThrow();
});

test("ownership-era snapshots are deliberately rejected", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: 2,
      bid: { current: [] },
      ask: { current: [] },
      field: { currentValidThroughMs: null, bid: {}, ask: {} },
    }),
  ).toThrow(/unsupported pressure frontier snapshot version/);
});
