import { marketColor, marketHue } from "../../shared/math";
import {
  normalizeDisplayText,
  sameDisplayTitle,
} from "../../domain/markets/marketMetadata";
import { buildNegRiskPalette } from "../../rendering/colors/negRiskColors";
import {
  buildThresholdPalette,
  semanticYesNeutralNoScale,
} from "../../rendering/colors/thresholdColors";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "../../rendering/colors/signedVolume";
import type {
  EventDetails,
  EventInfo,
  EventMarket,
} from "../../domain/markets/eventDetails";
import type { EventId, TokenId } from "@polymarket/client";

export interface ChartMarketControl {
  readonly market: EventMarket;
  readonly primaryColor: string;
  readonly oppositeColor: string;
  /** Age-mode row label, or null when it would only repeat the event title. */
  readonly ageLabel: string | null;
}

export interface ChartDefinition {
  readonly eventId: EventId;
  /** Controls in display order. */
  readonly controls: readonly ChartMarketControl[];
  readonly pressureScales: ReadonlyMap<TokenId, SignedVolumeColorScale>;
}

export function buildChartDefinition(bundle: EventDetails): ChartDefinition {
  const { event, markets } = bundle;
  const pressureScales = buildPressureScales(event, markets);
  const controls = markets.map((market, index): ChartMarketControl => {
    const scale = pressureScales.get(market.yes.tokenId);
    const primaryColor = scale
      ? signedVolumeColor(1, scale)
      : marketColor(event.id, index);
    const oppositeColor = scale ? signedVolumeColor(-1, scale) : primaryColor;
    const repeatsEvent =
      markets.length === 1 && sameDisplayTitle(market.title, event.title);

    return {
      market,
      primaryColor,
      oppositeColor,
      ageLabel: repeatsEvent ? null : market.title,
    };
  });

  return { eventId: event.id, controls, pressureScales };
}

function buildPressureScales(
  event: EventInfo,
  markets: readonly EventMarket[],
): ReadonlyMap<TokenId, SignedVolumeColorScale> {
  const completeThreshold = buildThresholdPalette(event, markets);
  const liveThreshold = buildLiveThresholdPalette(event, markets);
  const threshold =
    liveThreshold && hasResolvedLiveTitleCollision(markets)
      ? liveThreshold
      : (completeThreshold ?? liveThreshold);
  if (threshold) {
    // A live-only palette deliberately omits resolved markets whose stale or
    // reused Gamma rows either make the complete family ambiguous or duplicate
    // a live semantic threshold. Keep those controls usable with ordinary
    // binary colors while preserving the coherent geometry for live markets.
    const scales = buildDefaultPressureScales(event, markets);
    for (const outcome of threshold.outcomes)
      scales.set(outcome.yesTokenId, outcome.scale);
    return scales;
  }

  const negRisk = buildNegRiskPalette(event, markets);
  if (negRisk)
    return new Map(
      negRisk.outcomes.map((outcome) => [outcome.yesTokenId, outcome.scale]),
    );

  return buildDefaultPressureScales(event, markets);
}

function hasResolvedLiveTitleCollision(
  markets: readonly EventMarket[],
): boolean {
  const liveTitles = new Set(
    markets
      .filter((market) => market.tradable)
      .map(marketDisplayKey)
      .filter(Boolean),
  );
  return markets.some(
    (market) => !market.tradable && liveTitles.has(marketDisplayKey(market)),
  );
}

/** Untitled markets have no display key, so they never collide. */
function marketDisplayKey(market: EventMarket): string {
  return normalizeDisplayText(market.groupItemTitle ?? market.question ?? "");
}

function buildLiveThresholdPalette(
  event: EventInfo,
  markets: readonly EventMarket[],
) {
  const liveMarkets = markets.filter((market) => market.tradable);
  if (liveMarkets.length === markets.length) return null;
  return buildThresholdPalette(event, liveMarkets);
}

function buildDefaultPressureScales(
  event: EventInfo,
  markets: readonly EventMarket[],
): Map<TokenId, SignedVolumeColorScale> {
  return new Map(
    markets.map((market, index) => [
      market.yes.tokenId,
      semanticYesNeutralNoScale(marketHue(event.id, index)),
    ]),
  );
}

export function pressureScaleForToken(
  definition: ChartDefinition,
  tokenId: TokenId,
): SignedVolumeColorScale {
  return (
    definition.pressureScales.get(tokenId) ?? DEFAULT_SIGNED_VOLUME_COLOR_SCALE
  );
}
