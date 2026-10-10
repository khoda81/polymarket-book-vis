import type {
  Event,
  Market,
  PublicClient,
  Series,
  TokenId,
} from "@polymarket/client";
import {
  buildEventDetails,
  loadEventDetails,
  type EventDetails,
} from "../markets/eventDetails";
import { marketDeadlineMs } from "../markets/marketDeadline";

export const SERIES_VISIBLE_ROWS = 7;
export const SERIES_PAGE_SIZE = 20;
export type SeriesPageDirection = "older" | "newer";

export interface SeriesMarketRow {
  readonly index: number;
  readonly event: Event;
  readonly market: Market;
  readonly tokenId: TokenId;
  readonly deadlineMs: number | null;
}

/** Each binary market owns one ordinal row; dates never determine its height. */
export function seriesMarketRows(events: readonly Event[]): SeriesMarketRow[] {
  const rows: SeriesMarketRow[] = [];
  const seen = new Set<Market["id"]>();
  for (const event of events)
    for (const market of event.markets) {
      const tokenId = market.outcomes.yes.tokenId;
      if (!tokenId || seen.has(market.id)) continue;
      seen.add(market.id);
      rows.push({
        index: rows.length,
        event,
        market,
        tokenId,
        deadlineMs: marketDeadlineMs(market),
      });
    }
  return rows;
}

/** Navigate by reported deadlines without inferring an interval or lifecycle. */
export function seriesCurrentRowIndex(
  rows: readonly SeriesMarketRow[],
  nowMs: number,
  eligible: (row: SeriesMarketRow) => boolean,
): number {
  const candidates = rows.filter(eligible);
  let next: SeriesMarketRow | undefined;
  let past: SeriesMarketRow | undefined;
  for (const row of candidates) {
    const deadline = row.deadlineMs;
    if (deadline === null) continue;
    if (deadline >= nowMs && (!next || deadline < next.deadlineMs!)) next = row;
    if (deadline < nowMs && (!past || deadline > past.deadlineMs!)) past = row;
  }
  return (next ?? past ?? candidates[0] ?? rows.at(-1))?.index ?? 0;
}

type EventPages = ReturnType<PublicClient["listEvents"]>;
type EventPage = Awaited<ReturnType<EventPages["firstPage"]>>;
type PagePosition =
  | { readonly kind: "first" }
  | {
      readonly kind: "more";
      readonly cursor: NonNullable<EventPage["nextCursor"]>;
    }
  | { readonly kind: "end" };
type SeriesCollection = "closed" | "open" | "upcoming";

function pagePosition(page: EventPage): PagePosition {
  if (!page.hasMore) return { kind: "end" };
  if (page.nextCursor === undefined)
    throw new Error("Series API returned a page without a continuation cursor");
  return { kind: "more", cursor: page.nextCursor };
}

/** Stable IDs distinguish contracts even when their names and dates coincide. */
export function mergeSeriesEvents(
  ...groups: readonly (readonly Event[])[]
): Event[] {
  const byId = new Map<Event["id"], Event>();
  for (const group of groups)
    for (const event of group) byId.set(event.id, event);

  return [...byId.values()].sort((a, b) => {
    const aEnd = Date.parse(a.schedule.endDate ?? "");
    const bEnd = Date.parse(b.schedule.endDate ?? "");
    return (
      (Number.isFinite(aEnd) ? aEnd : Infinity) -
        (Number.isFinite(bEnd) ? bEnd : Infinity) ||
      a.id.localeCompare(b.id, undefined, { numeric: true })
    );
  });
}

export async function seriesEventDetails(
  client: PublicClient,
  events: readonly Event[],
): Promise<EventDetails[]> {
  return Promise.all(
    events.map((event) =>
      // Single-market events need no extra Gamma-only ordering annotations.
      event.markets.length > 1
        ? loadEventDetails(client, event)
        : Promise.resolve(buildEventDetails(event, {})),
    ),
  );
}

/**
 * Start near the next reported event end and page forward. The history streams
 * remain unfiltered, so old open events and events without dates stay reachable.
 */
export class SeriesEventPager {
  private readonly common: {
    seriesIds: number[];
    order: string;
    pageSize: number;
  };
  private readonly pages: Record<SeriesCollection, EventPages>;
  private readonly positions: Record<SeriesCollection, PagePosition> = {
    closed: { kind: "first" },
    open: { kind: "first" },
    upcoming: { kind: "first" },
  };

  constructor(
    private readonly client: PublicClient,
    series: Pick<Series, "id">,
    nowMs = Date.now(),
  ) {
    const seriesId = Number(series.id);
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0)
      throw new Error(`Series id ${series.id} is not numeric`);
    this.common = {
      seriesIds: [seriesId],
      order: "endDate",
      pageSize: SERIES_PAGE_SIZE,
    };
    this.pages = {
      closed: client.listEvents({
        ...this.common,
        closed: true,
        ascending: false,
      }),
      open: client.listEvents({
        ...this.common,
        closed: false,
        ascending: true,
      }),
      upcoming: this.upcomingPages(nowMs),
    };
  }

  private upcomingPages(nowMs: number): EventPages {
    return this.client.listEvents({
      ...this.common,
      closed: false,
      ascending: true,
      endDateMin: new Date(nowMs).toISOString(),
    });
  }

  private collections(
    direction: SeriesPageDirection,
  ): readonly SeriesCollection[] {
    return direction === "older" ? ["closed", "open"] : ["upcoming"];
  }

  hasMore(direction: SeriesPageDirection): boolean {
    return this.collections(direction).some(
      (name) => this.positions[name].kind !== "end",
    );
  }

  async load(direction: SeriesPageDirection): Promise<EventDetails[]> {
    const loaded = await Promise.all(
      this.collections(direction).map(async (name) => {
        const position = this.positions[name];
        if (position.kind === "end") return null;
        const pages =
          position.kind === "first"
            ? this.pages[name]
            : this.pages[name].from(position.cursor);
        const page = await pages.firstPage();
        return { name, position: pagePosition(page), events: page.items };
      }),
    );
    const events = mergeSeriesEvents(
      ...loaded.map((value) => value?.events ?? []),
    );
    const details = await seriesEventDetails(this.client, events);
    // Commit continuation only after every event's metadata has loaded.
    for (const value of loaded)
      if (value) this.positions[value.name] = value.position;
    return details;
  }

  async refresh(focusTimeMs?: number): Promise<EventDetails[]> {
    const upcomingPages =
      focusTimeMs === undefined
        ? this.pages.upcoming
        : this.upcomingPages(focusTimeMs);
    const [older, newer, open] = await Promise.all([
      this.pages.closed.firstPage(),
      upcomingPages.firstPage(),
      this.positions.open.kind === "end"
        ? this.pages.open.firstPage()
        : Promise.resolve(null),
    ]);
    const details = await seriesEventDetails(
      this.client,
      mergeSeriesEvents(older.items, newer.items, open?.items ?? []),
    );
    if (this.positions.closed.kind === "end" && older.hasMore)
      this.positions.closed = pagePosition(older);
    if (open) this.positions.open = pagePosition(open);
    // Keep the SDK cursor while paging. An exhausted collection may acquire
    // more events; the first page reopens it without using a date-gap guess.
    if (
      focusTimeMs !== undefined ||
      (this.positions.upcoming.kind === "end" && newer.hasMore)
    ) {
      this.pages.upcoming = upcomingPages;
      this.positions.upcoming = pagePosition(newer);
    }
    return details;
  }
}
