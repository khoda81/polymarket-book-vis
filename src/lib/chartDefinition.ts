import { marketColor, marketHue } from "./math";
import {
  initialMarketLifecycle,
  type MarketLifecycle,
} from "./marketLifecycle";
import { resolutionOrder, sameDisplayTitle } from "./marketMetadata";
import { isActiveOrderMarket } from "./marketTradability";
import { buildNegRiskPalette } from "./negRiskColors";
import {
  buildThresholdPalette,
  semanticYesNeutralNoScale,
} from "./thresholdColors";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "./signedVolume";
import type { EventDetails } from "./eventDetails";
import type { Event, Market, MarketId, TokenId } from "@polymarket/client";

export interface ChartMarketControl {
  readonly market: Market;
  readonly tokenId: TokenId;
  readonly lifecycle: MarketLifecycle;
  readonly title: string;
  readonly iconUrl: string | null;
  readonly dotColor: string;
  readonly primaryColor: string;
  readonly oppositeColor: string;
  readonly order: number;
  readonly resolutionMs: number | null;
  readonly ageLabel: string;
  readonly suppressAgeIdentity: boolean;
}

export interface ChartDefinition {
  readonly event: Event;
  readonly controls: readonly ChartMarketControl[];
  readonly pressureScales: ReadonlyMap<TokenId, SignedVolumeColorScale>;
}

export function buildChartDefinition(bundle: EventDetails): ChartDefinition {
  const { event } = bundle;
  const eligible = event.markets.flatMap((market) => {
    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) return [];

    const lifecycle = initialMarketLifecycle(market);
    if (!isActiveOrderMarket(market) && lifecycle.kind !== "resolved")
      return [];

    return [{ market, tokenId, lifecycle }];
  });
  const markets = eligible.map(({ market }) => market);
  const chartEvent: Event = { ...event, markets };
  const pressureScales = buildPressureScales(
    chartEvent,
    bundle.thresholdByMarketId,
  );
  const orderByToken = resolutionOrder(
    chartEvent,
    bundle.resolutionMsByMarketId,
  );

  const controls = eligible.map(({ market, tokenId, lifecycle }, index) => {
    const scale = pressureScales.get(tokenId);
    const primaryColor = scale
      ? signedVolumeColor(1, scale)
      : marketColor(event.id, index);
    const oppositeColor = scale ? signedVolumeColor(-1, scale) : primaryColor;
    const title = market.groupItemTitle ?? market.question ?? "(untitled)";
    const suppressAgeIdentity =
      markets.length === 1 && sameDisplayTitle(title, event.title);

    return {
      market,
      tokenId,
      lifecycle,
      title,
      iconUrl: distinctMarketArtworkUrl(market, bundle.presentation.iconUrl),
      dotColor: primaryColor,
      primaryColor,
      oppositeColor,
      order: orderByToken.get(tokenId) ?? index,
      resolutionMs: bundle.resolutionMsByMarketId.get(market.id) ?? null,
      ageLabel: suppressAgeIdentity ? "" : title,
      suppressAgeIdentity,
    };
  });

  return {
    event: chartEvent,
    controls,
    pressureScales,
  };
}

function buildPressureScales(
  event: Event,
  thresholdByMarketId: ReadonlyMap<MarketId, number>,
): ReadonlyMap<TokenId, SignedVolumeColorScale> {
  const threshold = buildThresholdPalette(event, thresholdByMarketId);
  if (threshold)
    return new Map(
      threshold.outcomes.map((outcome) => [outcome.yesTokenId, outcome.scale]),
    );

  const negRisk = buildNegRiskPalette(event);
  if (negRisk)
    return new Map(
      negRisk.outcomes.map((outcome) => [outcome.yesTokenId, outcome.scale]),
    );

  const scales = new Map<TokenId, SignedVolumeColorScale>();
  for (const [index, market] of event.markets.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) continue;
    scales.set(tokenId, defaultPressureScaleForMarket(event, index));
  }
  return scales;
}

export function pressureScaleForToken(
  definition: ChartDefinition,
  tokenId: TokenId,
): SignedVolumeColorScale {
  return (
    definition.pressureScales.get(tokenId) ?? DEFAULT_SIGNED_VOLUME_COLOR_SCALE
  );
}

/**
 * Generic binary-market color rule shared by normal event cards and series
 * occurrences when no threshold/negative-risk palette applies.
 */
export function defaultPressureScaleForMarket(
  event: Event,
  marketIndex: number,
): SignedVolumeColorScale {
  return semanticYesNeutralNoScale(marketHue(event.id, marketIndex));
}

function distinctMarketArtworkUrl(
  market: Market,
  eventArtworkUrl: string | null,
): string | null {
  const marketArtworkUrl = market.icon?.trim() || market.image?.trim() || null;
  if (!marketArtworkUrl) return null;
  if (!eventArtworkUrl) return marketArtworkUrl;
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
