import { orderMarkets } from "./marketOrder";
import type { Event, PublicClient } from "@polymarket/client";

export interface EventDescription {
  readonly preview: string;
  readonly body: string;
}

export interface MarketRule {
  readonly marketId: string;
  readonly title: string;
  readonly body: string;
}

export interface EventPresentation {
  readonly iconUrl: string | null;
  readonly subtitle: string | null;
  readonly description: EventDescription | null;
  readonly resolutionSource: string | null;
  readonly endDate: string | null;
  readonly marketRules: readonly MarketRule[];
}

export interface EventBundle {
  readonly event: Event;
  readonly rawMarkets: readonly unknown[];
  readonly presentation: EventPresentation;
  readonly marketTitles: ReadonlyMap<string, string>;
  readonly marketIcons: ReadonlyMap<string, string>;
  readonly tokenNames: ReadonlyMap<string, string>;
  readonly oppositeTokenNames: ReadonlyMap<string, string>;
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

export async function loadEventBundle(
  client: PublicClient,
  event: Event,
): Promise<EventBundle> {
  // The SDK's typed Event omits a few Gamma-only fields we intentionally use.
  // Keep the untyped escape hatch isolated at this transport boundary.
  const gamma = (client as unknown as GammaTransport).gamma;
  const request = await gamma.get(`/events/${event.id}`);
  const response = request.value;
  if (!response.ok)
    throw new Error(`Gamma API returned status ${response.status}`);

  return buildEventBundle(event, await response.json());
}

export function buildEventBundle(
  event: Event,
  rawEventValue: unknown,
): EventBundle {
  const rawEvent = asRecord(rawEventValue);
  if (!rawEvent) throw new Error("Gamma event payload is not an object");

  const rawMarkets = Array.isArray(rawEvent.markets) ? rawEvent.markets : [];
  const orderedEvent: Event = {
    ...event,
    markets: orderMarkets(event, rawMarkets),
  };

  const iconUrl = artworkUrl(rawEvent.icon, rawEvent.image);
  const rawDescription = text(rawEvent.description);
  const usefulDescription = isUsefulDescription(rawDescription)
    ? rawDescription
    : null;
  const subtitle = text(rawEvent.subtitle);
  const resolutionSource = text(rawEvent.resolutionSource);
  const endDate = text(rawEvent.endDate);
  const description =
    usefulDescription === null
      ? null
      : {
          body: usefulDescription,
          preview:
            subtitle || descriptionPreview(usefulDescription) || "Description",
        };

  const marketTitles = new Map<string, string>();
  const marketIcons = new Map<string, string>();
  const marketDescriptions = new Map<string, string>();
  const tokenNames = new Map<string, string>();
  const oppositeTokenNames = new Map<string, string>();

  for (const rawMarketValue of rawMarkets) {
    const rawMarket = asRecord(rawMarketValue);
    if (!rawMarket) continue;

    const marketId = idText(rawMarket.id);
    if (!marketId) continue;

    const title = text(rawMarket.groupItemTitle);
    if (title) marketTitles.set(marketId, title);

    const marketIconUrl = artworkUrl(rawMarket.icon, rawMarket.image);
    if (marketIconUrl && !sameArtworkUrl(marketIconUrl, iconUrl))
      marketIcons.set(marketId, marketIconUrl);

    const marketDescription = text(rawMarket.description);
    if (
      isUsefulDescription(marketDescription) &&
      !sameDescription(marketDescription, rawDescription)
    )
      marketDescriptions.set(marketId, marketDescription);

    const outcomes = parseStringArray(rawMarket.outcomes);
    const tokenIds = parseStringArray(rawMarket.clobTokenIds);
    for (
      let index = 0;
      index < Math.min(outcomes.length, tokenIds.length);
      index++
    ) {
      const tokenId = tokenIds[index];
      const outcome = outcomes[index];
      if (!tokenId || !outcome) continue;

      tokenNames.set(tokenId, outcome);
      if (outcomes.length === 2 && tokenIds.length === 2) {
        const opposite = outcomes[1 - index];
        if (opposite) oppositeTokenNames.set(tokenId, opposite);
      }
    }
  }

  const marketRules = orderedEvent.markets.flatMap((market) => {
    const marketId = String(market.id);
    const body = marketDescriptions.get(marketId);
    if (!body) return [];
    return [
      {
        marketId,
        title: marketTitles.get(marketId) ?? market.question ?? "(untitled)",
        body,
      },
    ];
  });

  return {
    event: orderedEvent,
    rawMarkets,
    presentation: {
      iconUrl,
      subtitle: subtitle || null,
      description,
      resolutionSource: resolutionSource || null,
      endDate: endDate || null,
      marketRules,
    },
    marketTitles,
    marketIcons,
    tokenNames,
    oppositeTokenNames,
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
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

function idText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}
