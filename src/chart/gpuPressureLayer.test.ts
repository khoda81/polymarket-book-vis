import { expect, test } from "bun:test";
import { priceFromLegacyNumber as p } from "@/lib/price";
import type { PressureRun } from "@/lib/pressureFrontierSnapshot";
import { PressureResidentBuffer } from "./gpuPressureLayer";

test("resident pressure buffer suffix rebuild matches a fresh full rebuild", () => {
  const initial: PressureRun[] = [
    { price: p(0.2), shares: 10, frozenSteps: [] },
    {
      price: p(0.5),
      shares: 5,
      frozenSteps: [{ hiVolume: 20, validThroughMs: 1_000 }],
    },
  ];
  const resident = new PressureResidentBuffer();
  resident.rebuildFrom(initial, [10, 15], p(1), 500, 0);

  const updated: PressureRun[] = [
    initial[0]!,
    {
      price: p(0.5),
      shares: 7,
      frozenSteps: [
        { hiVolume: 24, validThroughMs: 900 },
        { hiVolume: 20, validThroughMs: 1_000 },
      ],
    },
  ];
  const firstFloat = resident.rebuildFrom(updated, [10, 17], p(1), 500, 1);

  const fresh = new PressureResidentBuffer();
  fresh.rebuildFrom(updated, [10, 17], p(1), 500, 0);

  expect(firstFloat).toBe(6);
  expect([...resident.usedData()]).toEqual([...fresh.usedData()]);
  expect(resident.instanceCount).toBe(4);
});

test("resident pressure buffer preserves instances across capacity growth", () => {
  const resident = new PressureResidentBuffer();
  resident.rebuildFrom(
    [
      { price: p(0.2), shares: 10, frozenSteps: [] },
      {
        price: p(0.5),
        shares: 5,
        frozenSteps: [{ hiVolume: 20, validThroughMs: 1_000 }],
      },
    ],
    [10, 15],
    p(1),
    500,
    0,
  );

  const expected = new Float32Array([
    0.2, 0.5, 0, 10, 0, 1, 0.5, 1, 0, 15, 0, 1, 0.5, 1, 15, 20, 0.5, 0,
  ]);
  expect([...resident.usedData()]).toEqual([...expected]);
});
