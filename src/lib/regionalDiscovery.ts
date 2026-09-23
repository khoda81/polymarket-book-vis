import type { Event } from "@polymarket/client";
import { createPublicClient } from "@polymarket/client";

type PublicClient = ReturnType<typeof createPublicClient>;

export const REGIONAL_TAG_SLUGS = ["iran", "middle-east"] as const;
export const DEFAULT_MIN_VOLUME = 10_000;
export const DEFAULT_RECENCY_DAYS = 30;
export const MAX_DISCOVERED_EVENTS = 8;

const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const DAY_MS = 86_400_000;

export interface RegionalDiscoveryFilters {
  readonly minVolume: number;
  readonly recencyDays: number;
}

export function hasRegionalTag(event: Event): boolean {
  return event.tags.some((tag) =>
    REGIONAL_TAG_SLUGS.some((slug) => tag.slug === slug),
  );
}

export function isRecentRegionalEvent(
  event: Event,
  filters: RegionalDiscoveryFilters,
  nowMs: number,
): boolean {
  const createdAtMs = Date.parse(event.createdAt ?? "");
  const volume = Number(event.metrics.volume);
  return (
    hasRegionalTag(event) &&
    event.state.closed === false &&
    Number.isFinite(createdAtMs) &&
    createdAtMs >= nowMs - filters.recencyDays * DAY_MS &&
    Number.isFinite(volume) &&
    volume >= filters.minVolume &&
    event.markets.some(
      (market) =>
        market.state.acceptingOrders === true &&
        Boolean(market.outcomes.yes.tokenId),
    )
  );
}

/** Query Gamma's topic and volume filters, then apply recency/tradability locally. */
export async function discoverRegionalEvents(
  client: PublicClient,
  filters: RegionalDiscoveryFilters,
  excludedIds: ReadonlySet<string>,
  excludedSlugs: ReadonlySet<string>,
  nowMs = Date.now(),
  excludedSeriesIds: ReadonlySet<string> = new Set(),
): Promise<Event[]> {
  const tags = await Promise.all(
    REGIONAL_TAG_SLUGS.map((slug) => client.fetchTag({ slug })),
  );
  const tagIds = tags.map((tag) => Number(tag.id));
  if (tagIds.some((id) => !Number.isSafeInteger(id)))
    throw new Error("Regional topic IDs are invalid");

  const found: Event[] = [];
  const seenIds = new Set(excludedIds);
  const pages = client.listEvents({
    tagIds,
    tagMatch: "any",
    closed: false,
    volumeMin: filters.minVolume,
    order: "createdAt",
    ascending: false,
    pageSize: PAGE_SIZE,
  });

  let pageCount = 0;
  for await (const page of pages) {
    pageCount++;
    for (const event of page.items) {
      const id = String(event.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (event.slug && excludedSlugs.has(event.slug)) continue;
      if (
        event.series.some((series) => excludedSeriesIds.has(String(series.id)))
      )
        continue;
      if (!isRecentRegionalEvent(event, filters, nowMs)) continue;
      found.push(event);
      if (found.length >= MAX_DISCOVERED_EVENTS) return found;
    }
    if (pageCount >= MAX_PAGES) break;
  }

  return found;
}
