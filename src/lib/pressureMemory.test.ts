import { expect, test } from "bun:test";
import {
  PressureMemory,
  ghostAlpha,
  type PressureCell,
} from "./pressureMemory";

function observe(
  memory: PressureMemory,
  volume: number,
  time: number,
): void {
  memory.observe([{ lo: 0, hi: 1, volume }], time);
}

function onlyCell(memory: PressureMemory): PressureCell {
  const cells = memory.snapshot();
  expect(cells).toHaveLength(1);
  return cells[0]!;
}

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
