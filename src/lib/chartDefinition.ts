import { marketColor, marketHue } from "./math";
import {
  initialMarketLifecycle,
  type MarketLifecycle,
} from "./marketLifecycle";
import {
  indexRawMarketsById,
  resolutionOrder,
  resolutionTimestamp,
  sameDisplayTitle,
} from "./marketMetadata";
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
import type { Event, TokenId } from "@polymarket/client";

export interface ChartMarketControl {
  readonly marketId: string;
  readonly tokenId: TokenId;
  readonly oppositeTokenId: TokenId | null;
  readonly conditionId: string | null;
  readonly primaryOutcome: string;
  readonly oppositeOutcome: string;
  readonly lifecycle: MarketLifecycle;
  readonly title: string;
  readonly iconUrl: string | null;
  readonly dotColor: string;
  readonly acceptingOrders: boolean;
  readonly order: number;
  readonly resolutionMs: number | null;
  readonly ageLabel: string;
  readonly suppressAgeIdentity: boolean;
}

export interface ChartDefinition {
  readonly event: Event;
  readonly controls: readonly ChartMarketControl[];
  readonly pressureScales: ReadonlyMap<string, SignedVolumeColorScale>;
  readonly tokenNames: ReadonlyMap<string, string>;
  readonly oppositeTokenNames: ReadonlyMap<string, string>;
}

export function buildChartDefinition(bundle: EventBundle): ChartDefinition {
  const { event, rawMarkets } = bundle;
  const pressureScales = buildPressureScales(event, rawMarkets);
  const rawById = indexRawMarketsById(rawMarkets);
  const orderByToken = resolutionOrder(event, rawMarkets);

  const controls = event.markets.flatMap((market, index) => {
    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) return [];

    const marketId = String(market.id);
    const scale = pressureScales.get(String(tokenId));
    const dotColor = scale
      ? signedVolumeColor(1, scale)
      : marketColor(event.id, index);
    const title =
      bundle.marketTitles.get(marketId) ??
      market.question ??
      "(untitled)";
    const suppressAgeIdentity =
      event.markets.length === 1 &&
      sameDisplayTitle(title, event.title);
    const timestamp = resolutionTimestamp(
      rawById.get(marketId),
      market,
    );

    return [{
      marketId,
      tokenId,
      oppositeTokenId: market.outcomes.no.tokenId,
      conditionId: market.conditionId
        ? String(market.conditionId)
        : null,
      primaryOutcome: market.outcomes.yes.label,
      oppositeOutcome: market.outcomes.no.label,
      lifecycle: initialMarketLifecycle(market),
      title,
      iconUrl: bundle.marketIcons.get(marketId) ?? null,
      dotColor,
      acceptingOrders: market.state.acceptingOrders === true,
      order: orderByToken.get(String(tokenId)) ?? index,
      resolutionMs: Number.isFinite(timestamp) ? timestamp : null,
      ageLabel: suppressAgeIdentity ? "" : title,
      suppressAgeIdentity,
    }];
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
  rawMarkets: readonly unknown[],
): ReadonlyMap<string, SignedVolumeColorScale> {
  const threshold = buildThresholdPalette(event, rawMarkets);
  if (threshold)
    return new Map(
      threshold.outcomes.map((outcome) => [
        outcome.yesTokenId,
        outcome.scale,
      ]),
    );

  const negRisk = buildNegRiskPalette(event);
  if (negRisk)
    return new Map(
      negRisk.outcomes.map((outcome) => [
        outcome.yesTokenId,
        outcome.scale,
      ]),
    );

  const scales = new Map<string, SignedVolumeColorScale>();
  for (const [index, market] of event.markets.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) continue;
    scales.set(
      String(tokenId),
      semanticYesNeutralNoScale(marketHue(event.id, index)),
    );
  }
  return scales;
}

export function pressureScaleForToken(
  definition: ChartDefinition,
  tokenId: string,
): SignedVolumeColorScale {
  return (
    definition.pressureScales.get(String(tokenId)) ??
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE
  );
}
