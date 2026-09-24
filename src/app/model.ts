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
