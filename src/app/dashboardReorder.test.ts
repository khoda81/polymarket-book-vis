import { expect, test } from "bun:test";
import {
  dashboardOrderForPointer,
  type DashboardDragSnapshot,
} from "./dashboardReorder";

const snapshot: DashboardDragSnapshot = {
  order: ["a", "b", "c", "d"],
  grid: {
    left: 0,
    top: 0,
    columnWidth: 100,
    columnGap: 20,
    rowHeight: 4,
    rowGap: 16,
    columnCount: 2,
  },
  grabOffset: { x: 80, y: 20 },
  items: [
    { key: "a", height: 100, rowSpan: 6 },
    { key: "b", height: 180, rowSpan: 10 },
    { key: "c", height: 100, rowSpan: 6 },
    { key: "d", height: 100, rowSpan: 6 },
  ],
};

test("same drag-start snapshot and pointer always give the same order", () => {
  const pointer = { x: 200, y: 220 };
  const first = dashboardOrderForPointer(snapshot, "a", pointer);
  const second = dashboardOrderForPointer(snapshot, "a", pointer);

  expect(second).toEqual(first);
});

test("chooses the insertion whose dragged grab point is nearest the cursor", () => {
  // Inserting a after b and c puts it in the shorter second lane at y=120,
  // so its original grab point lands at (200, 140).
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 202, y: 142 }),
  ).toEqual(["b", "c", "a", "d"]);

  // Leaving it first keeps the grab point at (80, 20).
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 78, y: 18 }),
  ).toEqual(["a", "b", "c", "d"]);
});

test("different card heights are accounted for by masonry simulation", () => {
  // With b much taller than c, putting a late in the order lands it in the
  // shorter left lane, rather than simply after whichever old rectangle is
  // nearest to the pointer.
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 80, y: 220 }),
  ).toEqual(["b", "c", "d", "a"]);
});

test("exact ties prefer the drag-start insertion index", () => {
  const tied: DashboardDragSnapshot = {
    order: ["a", "b"],
    grid: {
      left: 0,
      top: 0,
      columnWidth: 100,
      columnGap: 0,
      rowHeight: 4,
      rowGap: 16,
      columnCount: 1,
    },
    grabOffset: { x: 50, y: 50 },
    items: [
      { key: "a", height: 100, rowSpan: 6 },
      { key: "b", height: 100, rowSpan: 6 },
    ],
  };

  // Midway between a's grab point at y=50 and its candidate point at y=170.
  expect(
    dashboardOrderForPointer(tied, "a", { x: 50, y: 110 }),
  ).toEqual(["a", "b"]);
});
