import type { TokenId } from "@polymarket/client";
import {
  ageRowYDirection,
  type AgeRowOrientation,
} from "@/chart/age/ageStripOrientation";
import type { PressureBar, PressureRow } from "@/chart/age/pressureRows";
import type { ChartMarketControl } from "@/chart/configuration/chartDefinition";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/rendering/colors/signedVolume";

const complement = (price: number) => 1 - price;

/**
 * A binary market's row. Each token's track holds its asks, and an ask for
 * one token at p is a bid for the other at 1 - p, so each bar is drawn and
 * quoted as the other token: yes asks are the no side, mirrored, in the
 * negative color; no asks are the yes side, in the positive color.
 */
export function marketPressureRow(
  control: ChartMarketControl,
  scale: SignedVolumeColorScale,
  orientation: AgeRowOrientation,
): PressureRow {
  const { yes, no } = control.market.outcomes;
  const bar = (
    track: TokenId,
    trackLabel: string,
    quoteLabel: string,
    colorSign: -1 | 1,
  ): PressureBar => ({
    track,
    trackLabel,
    color: signedVolumeColor(colorSign, scale),
    side: ageRowYDirection(colorSign, orientation) < 0 ? "above" : "below",
    priceAxis: colorSign < 0 ? "descending" : "ascending",
    quote: { label: quoteLabel, price: complement },
  });

  return {
    key: control.market.id,
    label: control.title,
    bars: [
      bar(control.tokenId, yes.label, no.label, -1),
      ...(no.tokenId ? [bar(no.tokenId, no.label, yes.label, 1)] : []),
    ],
  };
}

/**
 * The track drawn as a token's side of the row: its complement's asks.
 * Resolution makes the winner's side unbounded.
 */
export function pressureTrackForToken(
  primaryTokenId: TokenId,
  oppositeTokenId: TokenId | null,
  tokenId: TokenId,
): TokenId | null {
  if (tokenId === primaryTokenId) return oppositeTokenId;
  if (oppositeTokenId && tokenId === oppositeTokenId) return primaryTokenId;
  return null;
}
