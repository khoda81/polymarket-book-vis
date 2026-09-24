import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import {
  eventEndMs,
  eventStartMs,
  inferSeriesCadenceMs,
  mergeSeriesEvents,
  recurrenceDurationMs,
  timedSeriesEvent,
} from "./seriesTimeline";

function event(id: string, start: string, end: string): Event {
  return {
    id,
    schedule: {
      startDate: start,
      endDate: end,
    },
    markets: [],
  } as unknown as Event;
}

test("parses compact and named recurrences", () => {
  expect(recurrenceDurationMs("5m")).toBe(5 * 60_000);
  expect(recurrenceDurationMs("15m")).toBe(15 * 60_000);
  expect(recurrenceDurationMs("2h")).toBe(2 * 60 * 60_000);
  expect(recurrenceDurationMs("daily")).toBe(24 * 60 * 60_000);
  expect(recurrenceDurationMs("weekly")).toBe(7 * 24 * 60 * 60_000);
  expect(recurrenceDurationMs("nonsense")).toBeNull();
});

test("infers cadence from event start timestamps before recurrence metadata", () => {
  const events = [
    event("a", "2026-09-19T10:00:00Z", "2026-09-19T10:05:00Z"),
    event("b", "2026-09-19T10:05:00Z", "2026-09-19T10:10:00Z"),
    event("c", "2026-09-19T10:10:00Z", "2026-09-19T10:15:00Z"),
  ];
  expect(inferSeriesCadenceMs(events, "daily")).toBe(5 * 60_000);
});

test("timed rows use explicit event interval and merge stably by time", () => {
  const a = event("a", "2026-09-19T10:05:00Z", "2026-09-19T10:10:00Z");
  const b = event("b", "2026-09-19T10:00:00Z", "2026-09-19T10:05:00Z");
  const duplicateB = event("b", "2026-09-19T10:00:00Z", "2026-09-19T10:05:00Z");

  expect(eventStartMs(b)).toBe(Date.parse("2026-09-19T10:00:00Z"));
  expect(eventEndMs(b)).toBe(Date.parse("2026-09-19T10:05:00Z"));

  const timed = timedSeriesEvent(b, 60_000);
  expect(timed?.centerMs).toBe(Date.parse("2026-09-19T10:02:30Z"));

  expect(
    mergeSeriesEvents([a], [b, duplicateB]).map((row) => String(row.id)),
  ).toEqual(["b", "a"]);
});

test("series rows use cadence interval when market opens long before resolution", () => {
  const hourly = {
    id: "hourly",
    schedule: {
      startTime: "2026-09-23T16:00:00Z",
      endDate: "2026-09-24T17:00:00Z",
    },
    markets: [],
  } as unknown as Event;

  const timed = timedSeriesEvent(hourly, 60 * 60_000);
  expect(timed?.startMs).toBe(Date.parse("2026-09-24T16:00:00Z"));
  expect(timed?.endMs).toBe(Date.parse("2026-09-24T17:00:00Z"));
  expect(timed?.centerMs).toBe(Date.parse("2026-09-24T16:30:00Z"));
});
