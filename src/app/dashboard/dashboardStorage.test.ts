import { expect, test } from "bun:test";
import type { EventId, SeriesId } from "@polymarket/client";
import {
  COLUMN_COUNT_STORAGE_KEY,
  COLUMN_LAYOUT_STORAGE_KEY,
  LEGACY_COLUMN_LAYOUT_STORAGE_KEY,
  LAYOUT_ORDER_STORAGE_KEY,
  PINNED_EVENT_IDS_STORAGE_KEY,
  loadColumnCount,
  loadColumnLayout,
  loadDiscoveryNumber,
  loadLayoutOrder,
  loadStoredIds,
  persistIds,
  persistColumnLayout,
} from "./dashboardStorage";
import { DEFAULT_COLUMN_LAYOUT, learnColumnCount } from "./columnLayout";

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

test("legacy column preference migrates at its current width and persists the whole curve", () => {
  const storage = memoryStorage();
  storage.setItem(COLUMN_COUNT_STORAGE_KEY, "4");
  const migrated = loadColumnLayout(storage, 1400);
  expect(migrated).toEqual([0, 800, 1200, 1400]);
  persistColumnLayout(migrated, storage);
  expect(storage.getItem(COLUMN_LAYOUT_STORAGE_KEY)).toBe("[0,800,1200,1400]");
  expect(loadColumnCount(storage, 390)).toBe(1);
  expect(loadColumnCount(storage, 1000)).toBe(2);
  expect(loadColumnCount(storage, 1400)).toBe(4);
  expect(loadColumnCount(storage, 2000)).toBe(4);
  const learned = learnColumnCount(migrated, 1000, 1);
  persistColumnLayout(learned, storage);
  expect(loadColumnLayout(storage, 390)).toEqual(learned);
  expect(loadColumnCount(storage, 1000)).toBe(1);
  expect(loadColumnCount(storage, 1400)).toBe(4);
  storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, '[{"minWidth":0,"columns":0}]');
  storage.setItem(COLUMN_COUNT_STORAGE_KEY, "bad");
  expect(loadColumnLayout(storage, 390)).toEqual(DEFAULT_COLUMN_LAYOUT);
});

test("legacy breakpoint layouts migrate every count and preserve width behavior", () => {
  const storage = memoryStorage();
  const legacy = JSON.stringify([
    { minWidth: 0, columns: 1 },
    { minWidth: 800, columns: 2 },
    { minWidth: 1000, columns: 4 },
  ]);
  storage.setItem(LEGACY_COLUMN_LAYOUT_STORAGE_KEY, legacy);
  storage.setItem(COLUMN_COUNT_STORAGE_KEY, "12");

  const migrated = loadColumnLayout(storage, 390);
  expect(migrated).toEqual([0, 800, 1000, 1000]);
  expect(
    [0, 799, 800, 999, 1000, 2000].map((width) =>
      loadColumnCount(storage, width),
    ),
  ).toEqual([1, 1, 2, 2, 4, 4]);
  persistColumnLayout(migrated, storage);
  expect(storage.getItem(COLUMN_LAYOUT_STORAGE_KEY)).toBe("[0,800,1000,1000]");
  expect(storage.getItem(LEGACY_COLUMN_LAYOUT_STORAGE_KEY)).toBe(legacy);

  storage.setItem(LEGACY_COLUMN_LAYOUT_STORAGE_KEY, "[]");
  expect(loadColumnLayout(storage, 390)).toEqual(migrated);
});

test("legacy layouts with a higher starting count retain zero-width thresholds", () => {
  const storage = memoryStorage();
  storage.setItem(
    LEGACY_COLUMN_LAYOUT_STORAGE_KEY,
    JSON.stringify([
      { minWidth: 0, columns: 2 },
      { minWidth: 800, columns: 2 },
      { minWidth: 1200, columns: 4 },
    ]),
  );
  expect(loadColumnLayout(storage, 390)).toEqual([0, 0, 1200, 1200]);
  expect(loadColumnCount(storage, 0)).toBe(2);
  expect(loadColumnCount(storage, 1199)).toBe(2);
  expect(loadColumnCount(storage, 1200)).toBe(4);
});

test("malformed saved layouts are rejected before publishing internal thresholds", () => {
  const storage = memoryStorage();
  storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, "[0,800,799]");
  for (const legacy of [
    null,
    [],
    [0, 800],
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
      { minWidth: -1, columns: 2 },
    ],
    [
      { minWidth: 0, columns: 1 },
      { minWidth: 800.5, columns: 2 },
    ],
  ]) {
    storage.setItem(LEGACY_COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(legacy));
    expect(loadColumnLayout(storage, 390)).toEqual(DEFAULT_COLUMN_LAYOUT);
  }
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
