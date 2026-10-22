import type { EventId, SeriesId } from "@polymarket/client";
import { eventItemKey, isItemKey, seriesItemKey } from "./model";
import {
  DEFAULT_COLUMN_LAYOUT,
  columnsForWidth,
  learnColumnCount,
  parseColumnLayout,
  type ColumnLayout,
} from "./columnLayout";

export const PINNED_EVENT_IDS_STORAGE_KEY =
  "polymarket-book-vis:pinned-event-ids:v1";
export const PINNED_SERIES_IDS_STORAGE_KEY =
  "polymarket-book-vis:pinned-series-ids:v1";
export const COLUMN_COUNT_STORAGE_KEY =
  "polymarket-book-vis:dashboard-columns:v1";
export const COLUMN_LAYOUT_STORAGE_KEY =
  "polymarket-book-vis:dashboard-columns:v2";
export const LAYOUT_ORDER_STORAGE_KEY =
  "polymarket-book-vis:dashboard-order:v2";
// Keep the original storage keys so saved filters and dismissals survive
// the move from regional discovery to general event discovery.
export const DISCOVERY_VOLUME_STORAGE_KEY =
  "polymarket-book-vis:regional-min-volume:v1";
export const DISCOVERY_DAYS_STORAGE_KEY =
  "polymarket-book-vis:regional-days:v1";
export const DISMISSED_DISCOVERY_STORAGE_KEY =
  "polymarket-book-vis:dismissed-regional-events:v1";
export const DISCOVERY_TOPICS_STORAGE_KEY =
  "polymarket-book-vis:discovery-topics:v1";
export const DISCOVERY_LIQUIDITY_STORAGE_KEY =
  "polymarket-book-vis:discovery-min-liquidity:v1";
export const MIN_COLUMNS = 1;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function loadDiscoveryNumber(
  key: string,
  fallback: number,
  min: number,
  max: number,
  storage: StorageReader = localStorage,
): number {
  const raw = storage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function loadStoredJson(
  key: string,
  storage: StorageReader = localStorage,
): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return undefined;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Ignoring malformed localStorage value for ${key}:`, error);
    return undefined;
  }
}

export function loadDismissedDiscoveryIds(
  storage: StorageReader = localStorage,
): Set<EventId> {
  const parsed = loadStoredJson(DISMISSED_DISCOVERY_STORAGE_KEY, storage);
  return Array.isArray(parsed)
    ? new Set(
        parsed.filter(
          (id): id is string => typeof id === "string",
        ) as EventId[],
      )
    : new Set();
}

export function loadStoredIds<T extends string>(
  key: string,
  storage: StorageReader = localStorage,
): T[] {
  const parsed = loadStoredJson(key, storage);
  if (!Array.isArray(parsed)) return [];

  const ids = parsed.filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  return [...new Set(ids)] as T[];
}

export function loadColumnCount(
  storage: StorageReader = localStorage,
  viewportWidth = window.innerWidth,
): number {
  return columnsForWidth(
    loadColumnLayout(storage, viewportWidth),
    viewportWidth,
  );
}

export function loadColumnLayout(
  storage: StorageReader = localStorage,
  viewportWidth = window.innerWidth,
): ColumnLayout {
  const saved = parseColumnLayout(
    loadStoredJson(COLUMN_LAYOUT_STORAGE_KEY, storage),
  );
  if (saved) return saved;

  // A legacy count teaches the current width, rather than overriding every device size.
  const raw = storage.getItem(COLUMN_COUNT_STORAGE_KEY);
  if (raw !== null) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= MIN_COLUMNS)
      return learnColumnCount(DEFAULT_COLUMN_LAYOUT, viewportWidth, parsed);
  }
  return DEFAULT_COLUMN_LAYOUT;
}

export function persistColumnLayout(
  layout: ColumnLayout,
  storage: StorageWriter = localStorage,
): void {
  storage.setItem(COLUMN_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

export function loadLayoutOrder(
  eventPins: readonly EventId[],
  seriesPins: readonly SeriesId[],
  storage: StorageReader = localStorage,
): string[] {
  const parsed = loadStoredJson(LAYOUT_ORDER_STORAGE_KEY, storage);
  if (Array.isArray(parsed)) {
    const seen = new Set<string>();
    return parsed.filter((value): value is string => {
      if (typeof value !== "string" || seen.has(value) || !isItemKey(value))
        return false;
      seen.add(value);
      return true;
    });
  }

  return [...seriesPins.map(seriesItemKey), ...eventPins.map(eventItemKey)];
}

export function persistIds(
  key: string,
  ids: readonly string[],
  storage: StorageWriter = localStorage,
): void {
  storage.setItem(key, JSON.stringify(ids));
}
