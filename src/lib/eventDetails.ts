import { orderMarkets } from "./marketOrder";
import type {
  Event,
  Market,
  MarketId,
  PublicClient,
} from "@polymarket/client";

export interface EventDescription {
  readonly preview: string;
  readonly body: string;
}

export interface MarketRule {
  readonly marketId: MarketId;
  readonly title: string;
  readonly body: string;
}

export interface EventPresentation {
  readonly iconUrl: string | null;
  readonly description: EventDescription | null;
  readonly marketRules: readonly MarketRule[];
}

/**
 * One SDK Event plus the small amount of presentation and Gamma-only metadata
 * needed to initialize its chart. The Event/Market objects remain the source
 * of truth for identity, outcomes, labels, and lifecycle metadata.
 */
export interface EventDetails {
  readonly event: Event;
  readonly presentation: EventPresentation;
  readonly thresholdByMarketId: ReadonlyMap<MarketId, number>;
  readonly resolutionMsByMarketId: ReadonlyMap<MarketId, number>;
}

interface GammaGetResult {
  readonly value: Response;
}

interface GammaTransport {
  readonly gamma: {
    get(path: string): Promise<GammaGetResult>;
  };
}

const GENERIC_DESCRIPTION_LABELS = new Set([
  "description",
  "market rules",
  "resolution rules",
  "rule",
  "rules",
]);

export async function loadEventDetails(
  client: PublicClient,
  event: Event,
): Promise<EventDetails> {
  // Gamma exposes groupItemThreshold and a few legacy date fields that the
  // normalized SDK Market intentionally omits. Keep that raw transport detail
  // isolated here; the rest of the app consumes typed SDK models.
  const gamma = (client as unknown as GammaTransport).gamma;
  const request = await gamma.get(`/events/${event.id}`);
  const response = request.value;
  if (!response.ok)
    throw new Error(`Gamma API returned status ${response.status}`);

  return buildEventDetails(event, await response.json());
}

export function buildEventDetails(
  event: Event,
  rawEventValue: unknown,
): EventDetails {
  const rawEvent = asRecord(rawEventValue);
  if (!rawEvent) throw new Error("Gamma event payload is not an object");

  const rawMarkets = Array.isArray(rawEvent.markets) ? rawEvent.markets : [];
  const { thresholdByMarketId, resolutionMsByMarketId } =
    extractRawMarketAnnotations(event, rawMarkets);

  const orderedEvent: Event = {
    ...event,
    markets: orderMarkets(event, thresholdByMarketId),
  };

  const iconUrl = artworkUrl(event.icon, event.image);
  const rawDescription = text(event.description);
  const usefulDescription = isUsefulDescription(rawDescription)
    ? rawDescription
    : null;
  const subtitle = text(event.subtitle);
  const description =
    usefulDescription === null
      ? null
      : {
        body: usefulDescription,
        preview:
          subtitle || descriptionPreview(usefulDescription) || "Description",
      };

  const marketRules = orderedEvent.markets.flatMap((market) => {
    const body = text(market.description);
    if (
      !isUsefulDescription(body) ||
      sameDescription(body, rawDescription)
    )
      return [];

    return [
      {
        marketId: market.id,
        title:
          market.groupItemTitle ?? market.question ?? "(untitled)",
        body,
      },
    ];
  });

  return {
    event: orderedEvent,
    presentation: {
      iconUrl,
      description,
      marketRules,
    },
    thresholdByMarketId,
    resolutionMsByMarketId,
  };
}

function extractRawMarketAnnotations(
  event: Event,
  rawMarkets: readonly unknown[],
): {
  thresholdByMarketId: Map<MarketId, number>;
  resolutionMsByMarketId: Map<MarketId, number>;
} {
  const knownIds = new Map<string, MarketId>(
    event.markets.map((market) => [market.id, market.id]),
  );
  const thresholdByMarketId = new Map<MarketId, number>();
  const resolutionMsByMarketId = new Map<MarketId, number>();

  for (const rawMarketValue of rawMarkets) {
    const rawMarket = asRecord(rawMarketValue);
    if (!rawMarket) continue;

    const rawId =
      typeof rawMarket.id === "string" || typeof rawMarket.id === "number"
        ? String(rawMarket.id)
        : null;
    if (!rawId) continue;

    const marketId = knownIds.get(rawId);
    if (!marketId) continue;

    const threshold = numericValue(rawMarket.groupItemThreshold);
    if (threshold !== null) thresholdByMarketId.set(marketId, threshold);

    const rawState = asRecord(rawMarket.state);
    const resolutionMs = firstTimestamp(
      rawState?.endDate,
      rawState?.end_date,
      rawMarket.endDate,
      rawMarket.endDateIso,
      rawMarket.end_date,
      rawMarket.end_date_iso,
    );
    if (resolutionMs !== null)
      resolutionMsByMarketId.set(marketId, resolutionMs);
  }

  for (const market of event.markets) {
    if (resolutionMsByMarketId.has(market.id)) continue;
    const resolutionMs = marketResolutionMs(market);
    if (resolutionMs !== null)
      resolutionMsByMarketId.set(market.id, resolutionMs);
  }

  return { thresholdByMarketId, resolutionMsByMarketId };
}

function marketResolutionMs(market: Market): number | null {
  return firstTimestamp(market.state.endDate, market.state.closedTime);
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

function numericValue(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function descriptionPreview(description: string): string {
  return (
    description
      .split(/\n+/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function isUsefulDescription(description: string): boolean {
  if (!description.trim()) return false;
  const normalized = normalizeDescription(description).replace(/[.:]+$/, "");
  return !GENERIC_DESCRIPTION_LABELS.has(normalized);
}

function sameDescription(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  return normalizeDescription(a) === normalizeDescription(b);
}

function normalizeDescription(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function artworkUrl(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return null;
}

function sameArtworkUrl(a: string, b: string | null): boolean {
  if (!b) return false;
  if (a === b) return true;
  return normalizeArtworkUrl(a) === normalizeArtworkUrl(b);
}

function normalizeArtworkUrl(value: string): string {
  try {
    const url = new URL(value, "https://polymarket.com");
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
