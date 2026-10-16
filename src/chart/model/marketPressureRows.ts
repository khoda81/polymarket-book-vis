import type { TokenId } from "@polymarket/client";
import {
  ageRowYDirection,
  type AgeRowOrientation,
} from "@/chart/age/ageStripOrientation";
import type { PressureBar, PressureRow } from "@/chart/age/pressureRows";
import type { ChartMarketControl } from "@/chart/configuration/chartDefinition";
import type { EventMarket, MarketToken } from "@/domain/markets/eventDetails";
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
  const { market } = control;
  const bar = (
    track: MarketToken,
    quoted: MarketToken,
    colorSign: -1 | 1,
  ): PressureBar => ({
    track: track.tokenId,
    trackLabel: track.label,
    color: signedVolumeColor(colorSign, scale),
    side: ageRowYDirection(colorSign, orientation) < 0 ? "above" : "below",
    priceAxis: colorSign < 0 ? "descending" : "ascending",
    quote: { label: quoted.label, price: complement },
  });

  return {
    key: market.id,
    label: market.title,
    bars: [bar(market.yes, market.no, -1), bar(market.no, market.yes, 1)],
  };
}

/**
 * The track drawn as a token's side of the row: its complement's asks.
 * Resolution makes the winner's side unbounded.
 */
export function pressureTrackForToken(
  market: Pick<EventMarket, "yes" | "no">,
  tokenId: TokenId,
): TokenId | null {
  if (tokenId === market.yes.tokenId) return market.no.tokenId;
  if (tokenId === market.no.tokenId) return market.yes.tokenId;
  return null;
}
