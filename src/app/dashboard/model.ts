import type { Event, EventId, Series, SeriesId } from "@polymarket/client";

interface DashboardItemBase {
  readonly announceReady: boolean;
}

export interface EventDashboardItem extends DashboardItemBase {
  readonly kind: "event";
  readonly event: Event;
}

export interface SeriesDashboardItem extends DashboardItemBase {
  readonly kind: "series";
  readonly series: Series;
}

export type DashboardItem = EventDashboardItem | SeriesDashboardItem;

export function eventLabel(event: Event): string {
  return event.title?.trim() || event.slug?.trim() || "event";
}

export function seriesLabel(series: Series): string {
  return series.title?.trim() || series.slug?.trim() || "series";
}

export function itemLabel(entry: DashboardItem): string {
  return entry.kind === "series"
    ? seriesLabel(entry.series)
    : eventLabel(entry.event);
}

/** Pin or unpin `id`, keeping one occurrence at the requested edge. */
export function withPinned<T extends string>(
  ids: readonly T[],
  id: T,
  pinned: boolean,
  placement: "start" | "end",
): T[] {
  const without = ids.filter((candidate) => candidate !== id);
  if (!pinned) return without;
  return placement === "start" ? [id, ...without] : [...without, id];
}

export function orderDashboardItems(
  items: readonly DashboardItem[],
  order: readonly string[],
): DashboardItem[] {
  const ranks = new Map(order.map((key, index) => [key, index]));

  return [...items].sort((a, b) => {
    const aRank = ranks.get(itemKey(a));
    const bRank = ranks.get(itemKey(b));
    if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
    if (aRank !== undefined) return -1;
    if (bRank !== undefined) return 1;
    return 0;
  });
}

export function eventItemKey(id: EventId): string {
  return `event:${id}`;
}

export function seriesItemKey(id: SeriesId): string {
  return `series:${id}`;
}

export function isItemKey(value: string): boolean {
  return value.startsWith("event:") || value.startsWith("series:");
}

export function itemKey(entry: DashboardItem): string {
  return entry.kind === "series"
    ? seriesItemKey(entry.series.id)
    : eventItemKey(entry.event.id);
}
