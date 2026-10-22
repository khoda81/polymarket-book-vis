import { expect, test } from "bun:test";
import {
  DEFAULT_COLUMN_LAYOUT,
  columnsForWidth,
  learnColumnCount,
  parseColumnLayout,
  type ColumnLayout,
} from "./columnLayout";

test("learning a count preserves compatible steps and clips conflicting ones", () => {
  let layout = learnColumnCount(DEFAULT_COLUMN_LAYOUT, 1000, 4);
  expect(layout).toEqual([
    { minWidth: 0, columns: 1 },
    { minWidth: 800, columns: 2 },
    { minWidth: 1000, columns: 4 },
  ]);
  layout = learnColumnCount(layout, 900, 1);
  expect(layout).toEqual([
    { minWidth: 0, columns: 1 },
    { minWidth: 1000, columns: 4 },
  ]);
  layout = learnColumnCount(layout, 1000, 2);
  expect(columnsForWidth(layout, 999)).toBe(1);
  expect(columnsForWidth(layout, 1000)).toBe(2);
  expect(columnsForWidth(layout, 2000)).toBe(2);
  expect(DEFAULT_COLUMN_LAYOUT[1]!.columns).toBe(2);
});

test("successive contradictory choices stay monotone and honor the latest choice", () => {
  let layout: ColumnLayout = DEFAULT_COLUMN_LAYOUT;
  const constraints: [number, number][] = [
    [390, 2],
    [1600, 5],
    [900, 1],
    [1200, 6],
    [1200, 3],
    [0, 2],
    [3000, 1],
  ];
  for (const [width, count] of constraints) {
    layout = learnColumnCount(layout, width, count);
    expect(columnsForWidth(layout, width)).toBe(count);
    expect(parseColumnLayout(layout)).toEqual(layout);
    let previous = 0;
    for (let sample = 0; sample <= 4000; sample += 10) {
      const columns = columnsForWidth(layout, sample);
      expect(columns).toBeGreaterThanOrEqual(previous);
      previous = columns;
    }
    expect(
      layout.every(
        (step, index) =>
          index === 0 || step.columns > layout[index - 1]!.columns,
      ),
    ).toBe(true);
  }
});

test("persisted step functions reject invalid widths, counts, ordering, and missing origins", () => {
  for (const value of [
    null,
    [],
    [{ minWidth: 800, columns: 2 }],
    [{ minWidth: 0, columns: 0 }],
    [{ minWidth: 0, columns: 1.5 }],
    [
      { minWidth: 0, columns: 2 },
      { minWidth: 800, columns: 1 },
    ],
    [
      { minWidth: 0, columns: 1 },
      { minWidth: 0, columns: 2 },
    ],
    [
      { minWidth: 0, columns: 1 },
      { minWidth: Infinity, columns: 2 },
    ],
  ])
    expect(parseColumnLayout(value)).toBeNull();
});
