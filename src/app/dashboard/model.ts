import type { Event, Series } from "@polymarket/client";

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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function itemKey(entry: DashboardItem): string {
  if (entry.kind === "series") return `series:${entry.series.id}`;
  return `event:${entry.event.id}`;
}
