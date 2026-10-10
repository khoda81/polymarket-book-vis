import { expect, test } from "bun:test";
import type { Event, Market, PublicClient, Series } from "@polymarket/client";
import {
  mergeSeriesEvents,
  seriesMarketRows,
  seriesCurrentRowIndex,
  SeriesEventPager,
} from "./seriesMarkets";

function market(id: string, name: string, endDate?: string): Market {
  return {
    id,
    groupItemTitle: name,
    state: { endDate },
    outcomes: { yes: { tokenId: `yes-${id}` }, no: { tokenId: `no-${id}` } },
  } as unknown as Market;
}

function event(
  id: string,
  markets: Market[] = [],
  endDate?: string | null,
): Event {
  return {
    id,
    title: id,
    schedule: { endDate },
    display: { sortBy: "ascending" },
    markets,
  } as unknown as Event;
}

test("all markets have distinct ordinal rows even with identical names and dates", () => {
  const sameEnd = "2026-10-31T23:59:00Z";
  const events = [
    event("old", [market("1", "October 31", sameEnd)], sameEnd),
    event(
      "new",
      [
        market("2", "October 15", "2026-10-16T03:59:00Z"),
        market("3", "October 31", sameEnd),
        market("4", "Undated"),
      ],
      sameEnd,
    ),
  ];
  const rows = seriesMarketRows(events);
  expect(rows.map((row) => [row.index, String(row.market.id)])).toEqual([
    [0, "1"],
    [1, "2"],
    [2, "3"],
    [3, "4"],
  ]);
  expect(rows[1]!.deadlineMs).toBe(Date.parse("2026-10-16T03:59:00Z"));
  expect(rows[3]!.deadlineMs).toBeNull();
  expect(seriesMarketRows([...events, events[0]!])).toHaveLength(4);
});

test("event merging updates by identity and retains coincident and undated events", () => {
  const old = event("1", [], "2026-10-31T23:59:00Z");
  const updated = { ...old, title: "updated" };
  const other = event("2", [], old.schedule.endDate);
  const missing = event("3");
  const merged = mergeSeriesEvents([old, missing], [updated, other]);
  expect(merged.map((value) => String(value.id))).toEqual(["1", "2", "3"]);
  expect(merged[0]!.title).toBe("updated");
});

test("pagination retains equal-date and undated events while focus uses the actual clock", async () => {
  const requests: Record<string, unknown>[] = [];
  const open = Array.from({ length: 45 }, (_, i) =>
    event(String(i + 1), [], "2026-10-31T23:59:00Z"),
  );
  const closed = [event("old-undated")];
  const client = {
    listEvents(request: Record<string, unknown>) {
      requests.push(request);
      const source = request.closed ? closed : open;
      const pages = (offset = 0) => ({
        from: (cursor?: string) =>
          pages(cursor ? Number(cursor) : source.length),
        async firstPage() {
          const size = request.pageSize as number;
          return {
            items: source.slice(offset, offset + size),
            hasMore: offset + size < source.length,
            nextCursor: String(offset + size),
          };
        },
      });
      return pages();
    },
  } as unknown as PublicClient;
  const now = Date.parse("2026-10-10T00:00:00Z");
  const pager = new SeriesEventPager(
    client,
    { id: "12792" as Series["id"] },
    now,
  );
  const found = [];
  while (pager.hasMore("newer")) found.push(...(await pager.load("newer")));
  expect(found.map((detail) => detail.event.id)).toEqual(
    open.map((value) => value.id),
  );
  const history = [];
  while (pager.hasMore("older")) history.push(...(await pager.load("older")));
  expect(history.some((detail) => detail.event.id === "old-undated")).toBe(
    true,
  );
  expect(pager.hasMore("older")).toBe(false);
  expect(requests.filter((request) => !("endDateMin" in request))).toHaveLength(
    2,
  );
  expect(requests.find((request) => "endDateMin" in request)?.endDateMin).toBe(
    new Date(now).toISOString(),
  );
  expect(requests.every((request) => !("endDateMax" in request))).toBe(true);
});

test("current navigation skips stale open deadlines without changing their lifecycle", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  const rows = seriesMarketRows([
    event("event", [
      market("old", "Still open", "2025-12-19T16:40:00Z"),
      market("far", "Far future", "2026-12-31T23:59:00Z"),
      market("next", "Next deadline", "2026-10-10T00:05:00Z"),
      market("unknown", "Undated"),
    ]),
  ]);
  expect(seriesCurrentRowIndex(rows, now, () => true)).toBe(2);
  expect(
    seriesCurrentRowIndex(rows, now, (row) => row.market.id === "unknown"),
  ).toBe(3);
  expect(rows[0]!.market.state.closed).toBeUndefined();
});

test("new undated open events stay reachable after refresh", async () => {
  const open: Event[] = [];
  const client = {
    listEvents(request: Record<string, unknown>) {
      return {
        firstPage: async () => ({
          items: request.closed || request.endDateMin ? [] : open,
          hasMore: false,
        }),
      };
    },
  } as unknown as PublicClient;
  const pager = new SeriesEventPager(client, { id: "12792" as Series["id"] });
  await pager.load("older");
  await pager.load("newer");
  open.push(event("new-undated", [market("undated", "Undated")]));
  const refreshed = await pager.refresh();
  expect(
    seriesMarketRows(refreshed.map((detail) => detail.event))[0]!.deadlineMs,
  ).toBeNull();
});

test("failed metadata loading retries the same page before advancing its cursor", async () => {
  let attempts = 0;
  let pageCalls = 0;
  const source = event("1", [
    market("1", "October 15"),
    market("2", "October 31"),
  ]);
  const client = {
    listEvents() {
      return {
        firstPage: async () => {
          pageCalls++;
          return { items: [source], hasMore: false };
        },
      };
    },
    gamma: {
      async get() {
        if (++attempts === 1) throw new Error("Temporary metadata failure");
        return { value: new Response(JSON.stringify({ markets: [] })) };
      },
    },
  } as unknown as PublicClient;
  const pager = new SeriesEventPager(client, { id: "12792" as Series["id"] });
  await expect(pager.load("newer")).rejects.toThrow(
    "Temporary metadata failure",
  );
  expect(pager.hasMore("newer")).toBe(true);
  expect((await pager.load("newer"))[0]!.event.markets).toHaveLength(2);
  expect(pageCalls).toBe(2);
  expect(pager.hasMore("newer")).toBe(false);
});

test("refresh reopens an exhausted collection when more events are published", async () => {
  let expanded = false;
  const source = event("1");
  const client = {
    listEvents() {
      return {
        firstPage: async () => ({
          items: [source],
          hasMore: expanded,
          nextCursor: expanded ? "next" : undefined,
        }),
      };
    },
  } as unknown as PublicClient;
  const pager = new SeriesEventPager(client, { id: "12792" as Series["id"] });
  await pager.load("older");
  await pager.load("newer");
  expect(pager.hasMore("newer")).toBe(false);
  expanded = true;
  await pager.refresh();
  expect(pager.hasMore("older")).toBe(true);
  expect(pager.hasMore("newer")).toBe(true);
});
