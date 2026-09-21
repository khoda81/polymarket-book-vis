import { expect, test } from "bun:test";
import {
  PressureMemory,
  ghostAlpha,
  ghostVisibleSinceMs,
  rebasePressureCells,
  type PressureCell,
} from "./pressureMemory";

function observe(memory: PressureMemory, volume: number, time: number): void {
  memory.observe([{ lo: 0, hi: 1, volume }], time);
}

function onlyCell(memory: PressureMemory): PressureCell {
  const cells = memory.snapshot();
  expect(cells).toHaveLength(1);
  return cells[0]!;
}

test("visible ghost cutoff matches exponential alpha threshold", () => {
  const nowMs = 20_000;
  const halfLifeMs = 5_000;
  const threshold = 1 / 255;
  const cutoff = ghostVisibleSinceMs(nowMs, halfLifeMs, threshold);

  expect(ghostAlpha(cutoff, nowMs, halfLifeMs)).toBeCloseTo(threshold, 10);
  expect(ghostAlpha(cutoff + 1, nowMs, halfLifeMs)).toBeGreaterThan(threshold);
  expect(ghostAlpha(cutoff - 1, nowMs, halfLifeMs)).toBeLessThan(threshold);
});

test("shrinking live pressure leaves only the uncovered shell as a ghost", () => {
  const memory = new PressureMemory();
  observe(memory, 100, 1_000);
  observe(memory, 60, 2_000);

  expect(onlyCell(memory).bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 60,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("new pressure permanently overdraws ghost history", () => {
  const memory = new PressureMemory();
  observe(memory, 100, 1_000);
  observe(memory, 0, 2_000);
  observe(memory, -40, 3_000);

  expect(onlyCell(memory).bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 40,
      side: -1,
      state: { kind: "live" },
    },
    {
      loVolume: 40,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("older outer ghosts survive newer inner shrink events", () => {
  const memory = new PressureMemory();
  observe(memory, 100, 1_000);
  observe(memory, 60, 2_000);
  observe(memory, 30, 3_000);

  expect(onlyCell(memory).bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 30,
      side: 1,
      state: { kind: "live" },
    },
    {
      loVolume: 30,
      hiVolume: 60,
      side: 1,
      state: { kind: "ghost", sinceMs: 3_000 },
    },
    {
      loVolume: 60,
      hiVolume: 100,
      side: 1,
      state: { kind: "ghost", sinceMs: 2_000 },
    },
  ]);
});

test("price partition only splits where observations differ and merges again", () => {
  const memory = new PressureMemory();
  memory.observe(
    [
      { lo: 0, hi: 0.4, volume: 80 },
      { lo: 0.4, hi: 1, volume: 20 },
    ],
    1_000,
  );
  expect(memory.snapshot()).toHaveLength(2);

  memory.observe([{ lo: 0, hi: 1, volume: 50 }], 2_000);
  expect(memory.snapshot()).toHaveLength(2);

  memory.observe([{ lo: 0, hi: 1, volume: 100 }], 3_000);
  expect(memory.snapshot()).toHaveLength(1);
  expect(onlyCell(memory).bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 100,
      side: 1,
      state: { kind: "live" },
    },
  ]);
});

test("ghost decay uses half-life and pruning never removes live pressure", () => {
  expect(ghostAlpha(1_000, 2_000, 1_000)).toBeCloseTo(0.5);

  const memory = new PressureMemory();
  observe(memory, 100, 1_000);
  observe(memory, 40, 2_000);
  memory.prune(12_000, 1_000, 0.01);

  expect(onlyCell(memory).bands).toEqual([
    {
      loVolume: 0,
      hiVolume: 40,
      side: 1,
      state: { kind: "live" },
    },
  ]);
});

test("restore validates pressure memory and rebases ghost ages between clocks", () => {
  const cells = [
    {
      lo: 0,
      hi: 1,
      bands: [
        {
          loVolume: 0,
          hiVolume: 25,
          side: 1 as const,
          state: { kind: "ghost" as const, sinceMs: 8_000 },
        },
      ],
    },
  ];

  const restored = new PressureMemory();
  restored.restore(cells);
  expect(restored.snapshot()).toEqual(cells);

  const rebased = rebasePressureCells(cells, 10_000, 100_000);
  expect(rebased[0]?.bands[0]?.state).toEqual({
    kind: "ghost",
    sinceMs: 98_000,
  });
});

test("restore rejects non-contiguous volume bands", () => {
  const memory = new PressureMemory();
  expect(() =>
    memory.restore([
      {
        lo: 0,
        hi: 1,
        bands: [
          {
            loVolume: 0,
            hiVolume: 10,
            side: 1,
            state: { kind: "live" },
          },
          {
            loVolume: 5,
            hiVolume: 20,
            side: -1,
            state: { kind: "live" },
          },
        ],
      },
    ]),
  ).toThrow();
});

test("changing half-life can revive retained ghosts without mutating history", () => {
  const memory = new PressureMemory();
  observe(memory, 100, 0);
  observe(memory, 0, 1_000);

  expect(memory.hasVisibleGhosts(11_000, 100)).toBe(false);
  expect(memory.hasVisibleGhosts(11_000, 100_000)).toBe(true);
  expect(memory.hasGhosts()).toBe(true);
});

test("generated pressure memory always forms a contiguous volume prefix", () => {
  const memory = new PressureMemory();
  observe(memory, 100, 1_000);
  observe(memory, 60, 2_000);
  observe(memory, -30, 3_000);

  const bands = onlyCell(memory).bands;
  expect(bands[0]?.loVolume).toBe(0);
  for (let i = 1; i < bands.length; i++)
    expect(bands[i]!.loVolume).toBe(bands[i - 1]!.hiVolume);
});
