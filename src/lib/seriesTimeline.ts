import { AGE_ROW_BAND_PX } from "./ageStripTuning";
import type {
  Event,
  PublicClient,
  Series,
} from "@polymarket/client";

export const SERIES_ROW_HEIGHT_PX = AGE_ROW_BAND_PX;
export const SERIES_VISIBLE_ROWS = 7;
export const SERIES_WINDOW_ROWS = 64;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_CADENCE_MS = 5 * MINUTE_MS;

export interface TimedSeriesEvent {
  readonly event: Event;
  readonly startMs: number;
  readonly endMs: number;
  readonly centerMs: number;
}

export function eventStartMs(event: Event): number | null {
  return firstTimestamp(
    event.schedule.startTime,
    event.schedule.startDate,
    event.schedule.creationDate,
  );
}

export function eventEndMs(event: Event): number | null {
  const eventEnd = firstTimestamp(
    event.schedule.endDate,
    event.schedule.closedTime,
    event.schedule.finishedAt,
  );
  if (eventEnd !== null) return eventEnd;

  for (const market of event.markets) {
    const record = market as unknown as Record<string, unknown>;
    const state = asRecord(record.state);
    const value = firstTimestamp(
      state?.endDate,
      state?.end_date,
      record.endDate,
      record.endDateIso,
      record.end_date,
      record.end_date_iso,
    );
    if (value !== null) return value;
  }
  return null;
}

export function timedSeriesEvent(
  event: Event,
  fallbackDurationMs: number,
): TimedSeriesEvent | null {
  const startMs = eventStartMs(event);
  if (startMs === null) return null;

  const explicitEnd = eventEndMs(event);
  const endMs =
    explicitEnd !== null && explicitEnd > startMs
      ? explicitEnd
      : startMs + fallbackDurationMs;

  return {
    event,
    startMs,
    endMs,
    centerMs: (startMs + endMs) / 2,
  };
}

export function recurrenceDurationMs(
  recurrence: string | null | undefined,
): number | null {
  const value = recurrence?.trim().toLowerCase();
  if (!value) return null;

  const compact = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(value);
  if (compact) {
    const count = Number(compact[1]);
    if (!(count > 0)) return null;
    const unit = compact[2];
    const scale =
      unit === "s"
        ? 1_000
        : unit === "m"
          ? MINUTE_MS
          : unit === "h"
            ? HOUR_MS
            : unit === "d"
              ? DAY_MS
              : 7 * DAY_MS;
    return count * scale;
  }

  if (value === "hourly") return HOUR_MS;
  if (value === "daily") return DAY_MS;
  if (value === "weekly") return 7 * DAY_MS;
  // Calendar months are irregular. This is only a loading-window fallback;
  // actual event timestamps still determine placement.
  if (value === "monthly") return 30 * DAY_MS;

  return null;
}

export function inferSeriesCadenceMs(
  events: readonly Event[],
  recurrence: string | null | undefined,
): number {
  const starts = events
    .map(eventStartMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length > 0) return median(gaps);

  const durations = events
    .map((event) => {
      const start = eventStartMs(event);
      const end = eventEndMs(event);
      return start !== null && end !== null && end > start
        ? end - start
        : null;
    })
    .filter((value): value is number => value !== null);
  if (durations.length > 0) return median(durations);

  return recurrenceDurationMs(recurrence) ?? DEFAULT_CADENCE_MS;
}

export function mergeSeriesEvents(
  ...groups: readonly (readonly Event[])[]
): Event[] {
  const byId = new Map<string, Event>();
  for (const group of groups)
    for (const event of group) byId.set(String(event.id), event);

  return [...byId.values()].sort((a, b) => {
    const aStart = eventStartMs(a) ?? Infinity;
    const bStart = eventStartMs(b) ?? Infinity;
    return aStart - bStart || String(a.id).localeCompare(String(b.id));
  });
}

export async function loadSeriesEventsAround(
  client: PublicClient,
  series: Series,
  centerMs: number,
  cadenceHintMs: number,
): Promise<Event[]> {
  const seriesId = Number(series.id);
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0)
    throw new Error(`Series id ${String(series.id)} is not numeric`);

  const cadenceMs =
    Number.isFinite(cadenceHintMs) && cadenceHintMs > 0
      ? cadenceHintMs
      : recurrenceDurationMs(series.recurrence) ?? DEFAULT_CADENCE_MS;
  const halfWindowMs = SERIES_WINDOW_ROWS * cadenceMs;
  const startDateMin = new Date(centerMs - halfWindowMs).toISOString();
  const startDateMax = new Date(centerMs + halfWindowMs).toISOString();

  const common = {
    seriesIds: [seriesId],
    startDateMin,
    startDateMax,
    order: "startDate",
    ascending: true,
    pageSize: 100,
  };

  const [openEvents, closedEvents] = await Promise.all([
    collectEvents(client.listEvents({ ...common, closed: false })),
    collectEvents(client.listEvents({ ...common, closed: true })),
  ]);

  return mergeSeriesEvents(
    series.events ?? [],
    openEvents,
    closedEvents,
  ).filter((event) => {
    const start = eventStartMs(event);
    return (
      start !== null &&
      start >= centerMs - halfWindowMs - cadenceMs &&
      start <= centerMs + halfWindowMs + cadenceMs
    );
  });
}

async function collectEvents(
  pages: AsyncIterable<{
    readonly items: readonly Event[];
    readonly hasMore?: boolean;
  }>,
): Promise<Event[]> {
  const result: Event[] = [];
  let pageCount = 0;

  for await (const page of pages) {
    result.push(...page.items);
    pageCount++;
    if (pageCount >= 4 || result.length >= 400 || page.hasMore === false)
      break;
  }
  return result;
}

function firstTimestamp(...values: readonly unknown[]): number | null {
  for (const value of values) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
