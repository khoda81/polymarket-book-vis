import { marketColor, marketHue } from "./math";
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
  readonly title: string;
  readonly iconUrl: string | null;
  readonly dotColor: string;
}

export interface ChartDefinition {
  readonly event: Event;
  readonly rawMarkets: readonly unknown[];
  readonly controls: readonly ChartMarketControl[];
  readonly pressureScales: ReadonlyMap<string, SignedVolumeColorScale>;
  readonly tokenNames: ReadonlyMap<string, string>;
  readonly oppositeTokenNames: ReadonlyMap<string, string>;
}

export function buildChartDefinition(bundle: EventBundle): ChartDefinition {
  const { event, rawMarkets } = bundle;
  const pressureScales = buildPressureScales(event, rawMarkets);

  const controls = event.markets.flatMap((market, index) => {
    if (!market.state.active) return [];

    const tokenId = market.outcomes.yes.tokenId;
    if (!tokenId) return [];

    const marketId = String(market.id);
    const scale = pressureScales.get(String(tokenId));
    const dotColor = scale
      ? signedVolumeColor(1, scale)
      : marketColor(event.id, index);

    return [{
      marketId,
      tokenId,
      title:
        bundle.marketTitles.get(marketId) ??
        market.question ??
        "(untitled)",
      iconUrl: bundle.marketIcons.get(marketId) ?? null,
      dotColor,
    }];
  });

  return {
    event,
    rawMarkets,
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
