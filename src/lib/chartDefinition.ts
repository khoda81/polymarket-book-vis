import { marketColor, marketHue } from "./math";
import {
  initialMarketLifecycle,
  type MarketLifecycle,
} from "./marketLifecycle";
import { resolutionOrder, sameDisplayTitle } from "./marketMetadata";
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
import type { EventBundle } from "./eventBundle";
import type {
  ConditionId,
  Event,
  MarketId,
  TokenId,
} from "@polymarket/client";

export interface ChartMarketControl {
  readonly marketId: MarketId;
  readonly tokenId: TokenId;
  readonly oppositeTokenId: TokenId | null;
  readonly conditionId: ConditionId | null;
  readonly primaryOutcome: string;
  readonly oppositeOutcome: string;
  readonly lifecycle: MarketLifecycle;
  readonly title: string;
  readonly iconUrl: string | null;
  readonly dotColor: string;
  readonly primaryColor: string;
  readonly oppositeColor: string;
  readonly acceptingOrders: boolean;
  readonly order: number;
  readonly resolutionMs: number | null;
  readonly ageLabel: string;
  readonly suppressAgeIdentity: boolean;
}

export interface ChartDefinition {
  readonly event: Event;
  readonly controls: readonly ChartMarketControl[];
  readonly pressureScales: ReadonlyMap<TokenId, SignedVolumeColorScale>;
  readonly tokenNames: ReadonlyMap<TokenId, string>;
  readonly oppositeTokenNames: ReadonlyMap<TokenId, string>;
}

export function buildChartDefinition(bundle: EventBundle): ChartDefinition {
  const { event } = bundle;
  const pressureScales = buildPressureScales(
    event,
    bundle.thresholdByMarketId,
  );
  const orderByToken = resolutionOrder(
    event,
    bundle.resolutionMsByMarketId,
  );

  const controls = event.markets.flatMap((market, index) => {
    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) return [];

    const marketId = market.id;
    const scale = pressureScales.get(tokenId);
    const primaryColor = scale
      ? signedVolumeColor(1, scale)
      : marketColor(event.id, index);
    const oppositeColor = scale ? signedVolumeColor(-1, scale) : primaryColor;
    const dotColor = primaryColor;
    const title =
      bundle.marketTitles.get(marketId) ??
      market.groupItemTitle ??
      market.question ??
      "(untitled)";
    const suppressAgeIdentity =
      event.markets.length === 1 && sameDisplayTitle(title, event.title);

    return [
      {
        marketId,
        tokenId,
        oppositeTokenId: market.outcomes.no.tokenId,
        conditionId: market.conditionId,
        primaryOutcome: market.outcomes.yes.label,
        oppositeOutcome: market.outcomes.no.label,
        lifecycle: initialMarketLifecycle(market),
        title,
        iconUrl: bundle.marketIcons.get(marketId) ?? null,
        dotColor,
        primaryColor,
        oppositeColor,
        acceptingOrders: market.state.acceptingOrders === true,
        order: orderByToken.get(tokenId) ?? index,
        resolutionMs: bundle.resolutionMsByMarketId.get(marketId) ?? null,
        ageLabel: suppressAgeIdentity ? "" : title,
        suppressAgeIdentity,
      },
    ];
  });

  return {
    event,
    controls,
    pressureScales,
    tokenNames: bundle.tokenNames,
    oppositeTokenNames: bundle.oppositeTokenNames,
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
      negRisk.outcomes.map((outcome) => [
        outcome.yesTokenId as TokenId,
        outcome.scale,
      ]),
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
    definition.pressureScales.get(tokenId) ??
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE
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
