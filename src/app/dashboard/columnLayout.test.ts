import { expect, test } from "bun:test";
import {
  DEFAULT_COLUMN_LAYOUT,
  columnsForWidth,
  learnColumnCount,
  parseColumnLayout,
  type ColumnLayout,
} from "./columnLayout";

test("every column count keeps its threshold when choices share a boundary", () => {
  let layout = learnColumnCount(DEFAULT_COLUMN_LAYOUT, 1000, 4);
  expect(layout).toEqual([0, 800, 1000, 1000]);
  expect(columnsForWidth(layout, 799)).toBe(1);
  expect(columnsForWidth(layout, 800)).toBe(2);
  expect(columnsForWidth(layout, 999)).toBe(2);
  expect(columnsForWidth(layout, 1000)).toBe(4);
  layout = learnColumnCount(layout, 900, 1);
  expect(layout).toEqual([0, 1000, 1000, 1000]);
  expect(columnsForWidth(layout, 900)).toBe(1);
  expect(columnsForWidth(layout, 999)).toBe(1);
  expect(columnsForWidth(layout, 1000)).toBe(4);
  layout = learnColumnCount(layout, 1000, 2);
  expect(layout).toEqual([0, 1000]);
  expect(columnsForWidth(layout, 999)).toBe(1);
  expect(columnsForWidth(layout, 1000)).toBe(2);
  expect(columnsForWidth(layout, 2000)).toBe(2);
  expect(DEFAULT_COLUMN_LAYOUT).toEqual([0, 800, 1200]);
});

test("learning adjusts thresholds without inventing later width boundaries", () => {
  const layout = learnColumnCount(DEFAULT_COLUMN_LAYOUT, 900, 1);
  expect(layout).toEqual([0, 1200, 1200]);
  expect(columnsForWidth(layout, 1199)).toBe(1);
  expect(columnsForWidth(layout, 1200)).toBe(3);
  expect(learnColumnCount(layout, 1400, 1)).toEqual([0]);
  expect(learnColumnCount(DEFAULT_COLUMN_LAYOUT, 0, 2)).toEqual([0, 0, 1200]);
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
      expect(columns).toBeGreaterThanOrEqual(1);
      expect(columns).toBeLessThanOrEqual(layout.length);
      previous = columns;
    }
    expect(
      layout.every(
        (minWidth, index) => index === 0 || minWidth >= layout[index - 1]!,
      ),
    ).toBe(true);
  }
});

test("persisted thresholds reject invalid widths, holes, ordering, and missing origins", () => {
  for (const value of [
    null,
    [],
    [800],
    [-1, 800],
    [0, -1],
    [0, 800, 799],
    [0, 800.5],
    [0, Infinity],
    [0, NaN],
    [0, "800"],
    [0, null],
    [0, undefined, 1200],
    [{ minWidth: 0, columns: 1 }],
  ])
    expect(parseColumnLayout(value)).toBeNull();
});

test("parsing retains every shared threshold and owns the validated array", () => {
  const stored = [0, 0, 800, 800];
  const layout = parseColumnLayout(stored)!;
  expect(layout).toEqual([0, 0, 800, 800]);
  expect(columnsForWidth(layout, 0)).toBe(2);
  expect(columnsForWidth(layout, 799)).toBe(2);
  expect(columnsForWidth(layout, 800)).toBe(4);
  stored[1] = 900;
  expect(layout).toEqual([0, 0, 800, 800]);
});
