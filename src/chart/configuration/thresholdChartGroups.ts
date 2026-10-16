import {
  buildThresholdPalette,
  type ThresholdFamilyDirection,
  type ThresholdPalette,
} from "../../rendering/colors/thresholdColors";
import type {
  EventDetails,
  EventInfo,
  EventMarket,
} from "../../domain/markets/eventDetails";
import { subsetEventDetails } from "./subsetEventDetails";

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

  const classified = bundle.markets.map((market) => ({
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

  const highPalette = liveThresholdPalette(event, highMarkets);
  const lowPalette = liveThresholdPalette(event, lowMarkets);
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

function thresholdSide(market: EventMarket): ThresholdSide | null {
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
  event: EventInfo,
  markets: readonly EventMarket[],
): ThresholdPalette | null {
  const liveMarkets = markets.filter((market) => market.tradable);
  if (liveMarkets.length < 2) return null;
  return buildThresholdPalette(event, liveMarkets);
}
