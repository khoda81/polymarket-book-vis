import { expect, test } from "bun:test";
import type { Event, Series } from "@polymarket/client";
import { itemKey, orderDashboardItems, type DashboardItem } from "./model";

test("saved layout ranks precede unranked entries in stable insertion order", () => {
  const items: DashboardItem[] = [
    { kind: "event", event: { id: "a" } as Event, announceReady: false },
    { kind: "series", series: { id: "a" } as Series, announceReady: false },
    { kind: "event", event: { id: "b" } as Event, announceReady: false },
    { kind: "event", event: { id: "c" } as Event, announceReady: false },
  ];
  expect(
    orderDashboardItems(items, ["event:missing", "event:c", "series:a"]).map(
      itemKey,
    ),
  ).toEqual(["event:c", "series:a", "event:a", "event:b"]);
  expect(items.map(itemKey)).toEqual([
    "event:a",
    "series:a",
    "event:b",
    "event:c",
  ]);
});
