import { expect, test } from "bun:test";
import {
  dashboardOrderForPointer,
  type DashboardDragSnapshot,
} from "./dashboardReorder";

const snapshot: DashboardDragSnapshot = {
  order: ["a", "b", "c", "d"],
  items: [
    {
      key: "a",
      rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    },
    {
      key: "b",
      rect: { left: 120, top: 0, right: 220, bottom: 180, width: 100, height: 180 },
    },
    {
      key: "c",
      rect: { left: 0, top: 120, right: 100, bottom: 220, width: 100, height: 100 },
    },
    {
      key: "d",
      rect: { left: 120, top: 200, right: 220, bottom: 300, width: 100, height: 100 },
    },
  ],
};

test("same drag-start snapshot and pointer always give the same order", () => {
  const pointer = { x: 165, y: 240 };
  const first = dashboardOrderForPointer(snapshot, "a", pointer);

  // Calling it again after an arbitrary hypothetical reflow cannot affect it:
  // there is no current-layout input to consult.
  const second = dashboardOrderForPointer(snapshot, "a", pointer);

  expect(second).toEqual(first);
});

test("left and right halves map to fixed before and after regions", () => {
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 130, y: 90 }),
  ).toEqual(["a", "b", "c", "d"]);

  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 210, y: 90 }),
  ).toEqual(["b", "a", "c", "d"]);
});

test("pointer below a target inserts after it", () => {
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 170, y: 260 }),
  ).toEqual(["b", "c", "d", "a"]);
});

test("equidistant target ties are resolved by drag-start order", () => {
  const tied: DashboardDragSnapshot = {
    order: ["drag", "left", "right"],
    items: [
      {
        key: "drag",
        rect: { left: 0, top: 100, right: 100, bottom: 200, width: 100, height: 100 },
      },
      {
        key: "left",
        rect: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
      },
      {
        key: "right",
        rect: { left: 120, top: 0, right: 220, bottom: 100, width: 100, height: 100 },
      },
    ],
  };

  expect(
    dashboardOrderForPointer(tied, "drag", { x: 110, y: 50 }),
  ).toEqual(["left", "drag", "right"]);
});
