import { expect, test } from "bun:test";
import type { EventId, SeriesId } from "@polymarket/client";
import {
  COLUMN_COUNT_STORAGE_KEY,
  LAYOUT_ORDER_STORAGE_KEY,
  PINNED_EVENT_IDS_STORAGE_KEY,
  loadColumnCount,
  loadDiscoveryNumber,
  loadLayoutOrder,
  loadStoredIds,
  persistIds,
} from "./dashboardStorage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("saved pins retain order and IDs while invalid and duplicate values are removed", () => {
  const storage = memoryStorage();
  storage.setItem(
    PINNED_EVENT_IDS_STORAGE_KEY,
    JSON.stringify(["42", null, "", "  ", "19", "42", 99]),
  );
  const ids = loadStoredIds(PINNED_EVENT_IDS_STORAGE_KEY, storage);
  expect(ids).toEqual(["42", "19"]);
  persistIds(PINNED_EVENT_IDS_STORAGE_KEY, ids, storage);
  expect(storage.getItem("polymarket-book-vis:pinned-event-ids:v1")).toBe(
    '["42","19"]',
  );
});

test("layout falls back to legacy pin order only without a saved array", () => {
  const storage = memoryStorage();
  const events = ["e"] as EventId[];
  const series = ["s"] as SeriesId[];
  expect(loadLayoutOrder(events, series, storage)).toEqual([
    "series:s",
    "event:e",
  ]);
  storage.setItem(
    LAYOUT_ORDER_STORAGE_KEY,
    JSON.stringify(["event:e", "other:x", "series:s", "event:e", 7]),
  );
  expect(loadLayoutOrder(events, series, storage)).toEqual([
    "event:e",
    "series:s",
  ]);
  storage.setItem(LAYOUT_ORDER_STORAGE_KEY, "[]");
  expect(loadLayoutOrder(events, series, storage)).toEqual([]);
});

test("column defaults preserve viewport thresholds and honor saved counts", () => {
  const storage = memoryStorage();
  expect(
    [799, 800, 1199, 1200].map((width) => loadColumnCount(storage, width)),
  ).toEqual([1, 2, 2, 3]);
  storage.setItem(COLUMN_COUNT_STORAGE_KEY, "12");
  expect(loadColumnCount(storage, 500)).toBe(12);
  storage.setItem(COLUMN_COUNT_STORAGE_KEY, "1.5");
  expect(loadColumnCount(storage, 1200)).toBe(3);
});

test("discovery preferences validate missing and out-of-range persisted values", () => {
  const storage = memoryStorage();
  expect(loadDiscoveryNumber("amount", 10000, 0, 100000000, storage)).toBe(
    10000,
  );
  for (const invalid of ["-1", "NaN", "Infinity", "1.5", "100000001"]) {
    storage.setItem("amount", invalid);
    expect(loadDiscoveryNumber("amount", 10000, 0, 100000000, storage)).toBe(
      10000,
    );
  }
  storage.setItem("amount", "0");
  expect(loadDiscoveryNumber("amount", 10000, 0, 100000000, storage)).toBe(0);
});
