import type { Event } from "@polymarket/client";
import { createPublicClient } from "@polymarket/client";

type PublicClient = ReturnType<typeof createPublicClient>;

export const DEFAULT_MIN_VOLUME = 10_000;
export const DEFAULT_RECENCY_DAYS = 30;
export const MAX_DISCOVERED_EVENTS = 8;

const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const DAY_MS = 86_400_000;

export type DiscoveryOrder =
  "createdAt" | "volume" | "volume24hr" | "liquidity";

export interface EventDiscoveryFilters {
  readonly topics: readonly string[];
  readonly minVolume: number;
  readonly minLiquidity: number;
  /** Zero means any creation date. */
  readonly recencyDays: number;
  readonly order: DiscoveryOrder;
}

export function parseDiscoveryTopics(value: string): string[] {
  const topics = [
    ...new Set(
      value
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    topics.length > 10 ||
    topics.some((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))
  )
    throw new Error(
      "Use up to 10 comma-separated topic slugs (for example: politics, crypto).",
    );
  return topics;
}

export function validateDiscoveryFilters(filters: EventDiscoveryFilters): void {
  parseDiscoveryTopics(filters.topics.join(","));
  if (
    [filters.minVolume, filters.minLiquidity].some(
      (n) => !Number.isFinite(n) || n < 0 || n > 100_000_000,
    ) ||
    !Number.isInteger(filters.recencyDays) ||
    filters.recencyDays < 0 ||
    filters.recencyDays > 365 ||
    !["createdAt", "volume", "volume24hr", "liquidity"].includes(filters.order)
  )
    throw new Error(
      "Enter valid volume, liquidity, recency, and sorting filters.",
    );
}

export function matchesDiscoveryFilters(
  event: Event,
  filters: EventDiscoveryFilters,
  nowMs: number,
): boolean {
  const createdAtMs = Date.parse(event.createdAt ?? "");
  const volume = Number(event.metrics.volume);
  const liquidity = Number(event.metrics.liquidity);
  return (
    (filters.topics.length === 0 ||
      event.tags.some((tag) => filters.topics.includes(tag.slug ?? ""))) &&
    event.state.closed === false &&
    (filters.recencyDays === 0 ||
      (Number.isFinite(createdAtMs) &&
        createdAtMs >= nowMs - filters.recencyDays * DAY_MS)) &&
    Number.isFinite(volume) &&
    volume >= filters.minVolume &&
    (filters.minLiquidity === 0 ||
      (Number.isFinite(liquidity) && liquidity >= filters.minLiquidity)) &&
    event.markets.some(
      (market) =>
        market.state.acceptingOrders === true &&
        Boolean(market.outcomes.yes.tokenId),
    )
  );
}

/** Query Gamma's topics, volume and liquidity; apply creation recency/tradability locally. */
export async function discoverEvents(
  client: PublicClient,
  filters: EventDiscoveryFilters,
  excludedIds: ReadonlySet<string>,
  nowMs = Date.now(),
  excludedSeriesIds: ReadonlySet<string> = new Set(),
): Promise<Event[]> {
  validateDiscoveryFilters(filters);
  const tags = await Promise.all(
    filters.topics.map((slug) => client.fetchTag({ slug })),
  );
  const tagIds = tags.map((tag) => Number(tag.id));
  if (tagIds.some((id) => !Number.isSafeInteger(id)))
    throw new Error("Topic IDs are invalid");

  const found: Event[] = [];
  const seenIds = new Set(excludedIds);
  const pages = client.listEvents({
    ...(tagIds.length ? { tagIds, tagMatch: "any" as const } : {}),
    closed: false,
    volumeMin: filters.minVolume,
    liquidityMin: filters.minLiquidity,
    order: filters.order,
    ascending: false,
    pageSize: PAGE_SIZE,
  });

  let pageCount = 0;
  for await (const page of pages) {
    pageCount++;
    for (const event of page.items) {
      const id = event.id;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (event.series.some((series) => excludedSeriesIds.has(series.id)))
        continue;
      if (!matchesDiscoveryFilters(event, filters, nowMs)) continue;
      found.push(event);
      if (found.length >= MAX_DISCOVERED_EVENTS) return found;
    }
    if (pageCount >= MAX_PAGES) break;
  }

  return found;
}
