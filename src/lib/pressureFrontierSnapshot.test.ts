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

  const invalid = { ...before, current: [] };

  expect(() => memory.restore(invalid)).toThrow(/unexpected field current/);
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

test("already validated snapshots cross the restore boundary without reparsing", () => {
  const source = new PressureFrontierMemory();
  source.updateLevels([{ price: p(0.4), shares: 100 }], 1_000);

  const parsed = parsePressureFrontierSnapshot(source.snapshot());
  expect(parsePressureFrontierSnapshot(parsed)).toBe(parsed);

  const restored = new PressureFrontierMemory();
  restored.restore(parsed);
  expect(restored.snapshot()).toEqual(source.snapshot());
});

test("snapshot persists exact token-local coordinates and shares", () => {
  const memory = new PressureFrontierMemory();
  memory.updateLevels([{ price: p(0.013), shares: 25 }], 1);
  const snapshot = memory.snapshot();

  expect(snapshot.version).toBe(PRESSURE_FRONTIER_SNAPSHOT_VERSION);
  expect(snapshot.state.kind).toBe("observed");
  if (snapshot.state.kind !== "observed") throw new Error("expected observed");
  expect(snapshot.state.runs[0]).toMatchObject({
    price: p(0.013),
    shares: 25,
  });
  expect(snapshot.state.runs.every((run) => Number.isInteger(run.price))).toBe(
    true,
  );
});

test("unobserved pressure is a distinct structural state", () => {
  const memory = new PressureFrontierMemory();
  expect(memory.snapshot()).toEqual({
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    state: { kind: "unobserved" },
  });

  memory.observeThrough(1_000);
  expect(memory.snapshot()).toEqual({
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    state: { kind: "observed", validThroughMs: 1_000, runs: [] },
  });
});

test("v5 and other noncanonical snapshot versions are rejected", () => {
  for (const version of [3, 4, 5])
    expect(() =>
      parsePressureFrontierSnapshot({
        version,
        state: { kind: "unobserved" },
      }),
    ).toThrow(/unsupported pressure frontier snapshot version/);
});

test("canonical snapshots reject explicit price-zero pressure", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 1,
        runs: [{ price: p(0), shares: 1, frozenSteps: [] }],
      },
    }),
  ).toThrow(/must be in/);
});

test("canonical snapshots reject frozen steps at or below current prefix", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 2_000,
        runs: [
          {
            price: p(0.5),
            shares: 60,
            frozenSteps: [{ hiVolume: 60, validThroughMs: 1_000 }],
          },
        ],
      },
    }),
  ).toThrow(/must stay above current pressure/);
});

test("canonical snapshots reject nonmonotone step edges and timestamps", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 3_000,
        runs: [
          {
            price: p(0.5),
            shares: 40,
            frozenSteps: [
              { hiVolume: 80, validThroughMs: 2_000 },
              { hiVolume: 100, validThroughMs: 1_000 },
            ],
          },
        ],
      },
    }),
  ).toThrow(/upper edges must decrease/);

  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 3_000,
        runs: [
          {
            price: p(0.5),
            shares: 40,
            frozenSteps: [
              { hiVolume: 100, validThroughMs: 2_000 },
              { hiVolume: 80, validThroughMs: 2_000 },
            ],
          },
        ],
      },
    }),
  ).toThrow(/timestamps must increase/);
});

test("canonical snapshots reject redundant adjacent identical runs", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 2_000,
        runs: [
          {
            price: p(0.2),
            shares: 20,
            frozenSteps: [{ hiVolume: 40, validThroughMs: 1_000 }],
          },
          {
            price: p(0.5),
            shares: 0,
            frozenSteps: [{ hiVolume: 40, validThroughMs: 1_000 }],
          },
        ],
      },
    }),
  ).toThrow(/must be merged/);
});

test("old v5 geometry fields are rejected instead of silently normalized", () => {
  expect(() =>
    parsePressureFrontierSnapshot({
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: {
        kind: "observed",
        validThroughMs: 2_000,
        runs: [
          {
            price: p(0.5),
            shares: 60,
            frozenSteps: [
              {
                loVolume: 60,
                hiVolume: 100,
                validThroughMs: 1_000,
              },
            ],
          },
        ],
      },
    }),
  ).toThrow(/unexpected field loVolume/);
});
