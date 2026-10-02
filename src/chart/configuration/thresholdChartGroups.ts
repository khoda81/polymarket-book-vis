import {
  buildThresholdPalette,
  type ThresholdFamilyDirection,
  type ThresholdPalette,
} from "../../rendering/colors/thresholdColors";
import type { EventDetails } from "../../domain/markets/eventDetails";
import { isActiveOrderMarket } from "../../domain/markets/marketTradability";
import { subsetEventDetails } from "./subsetEventDetails";
import type { Event, Market, MarketId } from "@polymarket/client";

export type ThresholdMarketGroupKey = "high" | "low";

export interface ThresholdMarketGroup {
  readonly key: ThresholdMarketGroupKey;
  readonly label: string;
  readonly bundle: EventDetails;
  readonly direction: ThresholdFamilyDirection;
}

type ThresholdSide = "high" | "low";

/**
 * Split events that explicitly contain independent HIGH and LOW threshold
 * ladders. The text labels identify the two semantic families; a coherent
 * live threshold palette on both sides is required before changing the UI.
 */
export function thresholdMarketGroups(
  bundle: EventDetails,
): readonly ThresholdMarketGroup[] | null {
  const { event } = bundle;
  if (event.trading.negRisk === true || event.trading.negRiskAugmented === true)
    return null;

  const classified = event.markets.map((market) => ({
    market,
    side: thresholdSide(market),
  }));
  if (classified.some(({ side }) => side === null)) return null;

  const highMarkets = classified.flatMap(({ market, side }) =>
    side === "high" ? [market] : [],
  );
  const lowMarkets = classified.flatMap(({ market, side }) =>
    side === "low" ? [market] : [],
  );

  const highPalette = liveThresholdPalette(
    event,
    highMarkets,
    bundle.thresholdByMarketId,
  );
  const lowPalette = liveThresholdPalette(
    event,
    lowMarkets,
    bundle.thresholdByMarketId,
  );
  if (!highPalette || !lowPalette) return null;

  return [
    {
      key: "high",
      label: "↑ High thresholds",
      bundle: subsetEventDetails(bundle, highMarkets),
      direction: highPalette.direction,
    },
    {
      key: "low",
      label: "↓ Low thresholds",
      bundle: subsetEventDetails(bundle, lowMarkets),
      direction: lowPalette.direction,
    },
  ];
}

function thresholdSide(market: Market): ThresholdSide | null {
  const titleSide = arrowSide(market.groupItemTitle);
  const questionSide = parentheticalSide(market.question);
  if (titleSide && questionSide && titleSide !== questionSide) return null;
  return titleSide ?? questionSide;
}

function arrowSide(value: string | null | undefined): ThresholdSide | null {
  const title = value?.trimStart() ?? "";
  if (title.startsWith("↑")) return "high";
  if (title.startsWith("↓")) return "low";
  return null;
}

function parentheticalSide(
  value: string | null | undefined,
): ThresholdSide | null {
  if (/\(\s*HIGH\s*\)/iu.test(value ?? "")) return "high";
  if (/\(\s*LOW\s*\)/iu.test(value ?? "")) return "low";
  return null;
}

function liveThresholdPalette(
  event: Event,
  markets: readonly Market[],
  thresholdByMarketId: ReadonlyMap<MarketId, number>,
): ThresholdPalette | null {
  const liveMarkets = markets.filter(isActiveOrderMarket);
  if (liveMarkets.length < 2) return null;
  return buildThresholdPalette(
    { ...event, markets: liveMarkets },
    thresholdByMarketId,
  );
}
