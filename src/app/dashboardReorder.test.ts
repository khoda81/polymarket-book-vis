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

test("same pointer position always gives the same order", () => {
  const pointer = { x: 165, y: 240 };

  expect(
    dashboardOrderForPointer(snapshot, "a", pointer),
  ).toEqual(
    dashboardOrderForPointer(snapshot, "a", pointer),
  );
});

test("result depends on drag-start order, not an intermediate order", () => {
  const pointer = { x: 165, y: 240 };
  const expected = dashboardOrderForPointer(
    snapshot,
    "a",
    pointer,
  );

  // Simulate the live dashboard having already reflowed to a different order.
  const intermediate = {
    ...snapshot,
    order: ["b", "c", "a", "d"],
  };

  expect(
    dashboardOrderForPointer(snapshot, "a", pointer),
  ).toEqual(expected);
  expect(
    dashboardOrderForPointer(intermediate, "a", pointer),
  ).not.toEqual(expected);
});

test("left and right halves of a card map to before and after near its midline", () => {
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 130, y: 90 }),
  ).toEqual(["b", "a", "c", "d"]);

  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 210, y: 90 }),
  ).toEqual(["b", "a", "c", "d"]);
});

test("pointer below a target inserts after it", () => {
  expect(
    dashboardOrderForPointer(snapshot, "a", { x: 170, y: 260 }),
  ).toEqual(["b", "c", "d", "a"]);
});
