import { finiteNumber, timestampMs } from "../../shared/parse";
import { feeScheduleFromMarket, type FeeSchedule } from "../books/feeSchedule";
import {
  initialMarketLifecycle,
  type MarketLifecycle,
} from "./marketLifecycle";
import { marketTimeMarker, type MarketTimeMarker } from "./marketDeadline";
import { marketTitle, normalizeDisplayText } from "./marketMetadata";
import { orderMarkets } from "./marketOrder";
import { isActiveOrderMarket } from "./marketTradability";
import type {
  ConditionId,
  Event,
  Market,
  MarketId,
  PublicClient,
  TokenId,
} from "@polymarket/client";

export interface EventDescription {
  readonly preview: string;
  readonly body: string;
}

export interface EventPresentation {
  readonly iconUrl: string | null;
  readonly description: EventDescription | null;
}

/** An event's own metadata; its markets are parsed into EventDetails. */
export type EventInfo = Omit<Event, "markets">;

export interface MarketToken {
  readonly label: string;
  readonly tokenId: TokenId;
  /** Gamma's last reported price, if it is a finite number. */
  readonly price: number | null;
}

/**
 * A binary market with both outcome tokens, parsed once from the SDK market
 * and Gamma-only fields. Markets missing either token are not charted.
 */
export interface EventMarket {
  readonly id: MarketId;
  readonly conditionId: ConditionId | null;
  /** Row label: the group item title, else the question. */
  readonly title: string;
  readonly groupItemTitle: string | null;
  readonly question: string | null;
  readonly yes: MarketToken;
  readonly no: MarketToken;
  /** Active and accepting orders, so eligible for live order books. */
  readonly tradable: boolean;
  readonly closed: boolean;
  readonly archived: boolean;
  readonly negRisk: boolean;
  /** Lifecycle as reported by Gamma; streams may learn more later. */
  readonly reportedLifecycle: MarketLifecycle;
  /** Gamma's groupItemThreshold ordering key. */
  readonly threshold: number | null;
  /** Reported end date, falling back to the closing time. */
  readonly resolutionMs: number | null;
  readonly timeMarker: MarketTimeMarker | null;
  /** Market artwork, only when it differs from the event's. */
  readonly iconUrl: string | null;
  /** Market-specific rules, when they add to the event description. */
  readonly rule: string | null;
  /** Fee schedule carried by Gamma, if valid. */
  readonly feeSchedule: FeeSchedule | null;
}

export function marketTokenIds(
  market: Pick<EventMarket, "yes" | "no">,
): readonly [TokenId, TokenId] {
  return [market.yes.tokenId, market.no.tokenId];
}

export interface EventDetails {
  readonly event: EventInfo;
  readonly presentation: EventPresentation;
  /** Chartable markets in display order. */
  readonly markets: readonly EventMarket[];
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

  const { markets: sdkMarkets, ...info } = event;
  const rawMarkets = Array.isArray(rawEvent.markets) ? rawEvent.markets : [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const value of rawMarkets) {
    const rawMarket = asRecord(value);
    const id = rawMarket?.id;
    if (typeof id === "string" || typeof id === "number")
      rawById.set(String(id), rawMarket!);
  }

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

  const markets = sdkMarkets.flatMap((market) => {
    const parsed = parseMarket(
      market,
      rawById.get(market.id) ?? null,
      iconUrl,
      rawDescription,
    );
    return parsed ? [parsed] : [];
  });

  return {
    event: info,
    presentation: { iconUrl, description },
    markets: orderMarkets(markets, event.display.sortBy),
  };
}

function parseMarket(
  market: Market,
  raw: Record<string, unknown> | null,
  eventIconUrl: string | null,
  eventDescription: string,
): EventMarket | null {
  const { yes, no } = market.outcomes;
  if (!yes.tokenId || !no.tokenId) return null;

  const rawState = asRecord(raw?.state);
  const rule = text(market.description);
  return {
    id: market.id,
    conditionId: market.conditionId,
    title: marketTitle(market) ?? "(untitled)",
    groupItemTitle: market.groupItemTitle ?? null,
    question: market.question ?? null,
    yes: {
      label: yes.label,
      tokenId: yes.tokenId,
      price: finiteNumber(yes.price),
    },
    no: { label: no.label, tokenId: no.tokenId, price: finiteNumber(no.price) },
    tradable: isActiveOrderMarket(market),
    closed: market.state.closed === true,
    archived: market.state.archived === true,
    negRisk: market.state.negRisk === true,
    reportedLifecycle: initialMarketLifecycle(market),
    threshold: finiteNumber(raw?.groupItemThreshold),
    resolutionMs:
      firstTimestamp(
        rawState?.endDate,
        rawState?.end_date,
        raw?.endDate,
        raw?.endDateIso,
        raw?.end_date,
        raw?.end_date_iso,
      ) ?? marketResolutionMs(market),
    timeMarker: marketTimeMarker(market),
    iconUrl: distinctArtworkUrl(market, eventIconUrl),
    rule:
      isUsefulDescription(rule) && !sameDescription(rule, eventDescription)
        ? rule
        : null,
    feeSchedule: validFeeSchedule(market),
  };
}

function validFeeSchedule(market: Market): FeeSchedule | null {
  try {
    return feeScheduleFromMarket(market);
  } catch {
    // An invalid schedule falls back to the CLOB fee lookup.
    return null;
  }
}

function marketResolutionMs(market: Market): number | null {
  return firstTimestamp(market.state.endDate, market.state.closedTime);
}

function firstTimestamp(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const parsed = timestampMs(value);
    if (parsed !== null) return parsed;
  }
  return null;
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
  const normalized = normalizeDisplayText(description).replace(/[.:]+$/, "");
  return !GENERIC_DESCRIPTION_LABELS.has(normalized);
}

function sameDescription(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  return normalizeDisplayText(a) === normalizeDisplayText(b);
}

function artworkUrl(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    const value = text(candidate);
    if (value) return value;
  }
  return null;
}

function distinctArtworkUrl(
  market: Market,
  eventArtworkUrl: string | null,
): string | null {
  const marketArtworkUrl = artworkUrl(market.icon, market.image);
  if (!marketArtworkUrl || !eventArtworkUrl) return marketArtworkUrl;
  return normalizeArtworkUrl(marketArtworkUrl) ===
    normalizeArtworkUrl(eventArtworkUrl)
    ? null
    : marketArtworkUrl;
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
