import { expect, test } from "bun:test";
import type { TokenId } from "@polymarket/client";
import type { ChartMarketControl } from "@/chart/configuration/chartDefinition";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "@/rendering/colors/signedVolume";
import { eventMarket } from "@/shared/testing/eventMarkets";
import { marketPressureRow, pressureTrackForToken } from "./marketPressureRows";

const market = eventMarket("market", { title: "Will it rain?" });
const YES = market.yes.tokenId;
const NO = market.no.tokenId;

function control(): ChartMarketControl {
  return { market, primaryColor: "", oppositeColor: "", ageLabel: null };
}

test("each token's asks are drawn and quoted as the complementary side", () => {
  const row = marketPressureRow(
    control(),
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    "negative-above",
  );
  expect(row).toMatchObject({ key: "market", label: "Will it rain?" });
  const [yesAsks, noAsks] = row.bars;
  expect(yesAsks).toMatchObject({
    track: YES,
    trackLabel: "Yes",
    side: "above",
    priceAxis: "descending",
    quote: { label: "No" },
  });
  expect(noAsks).toMatchObject({
    track: NO,
    trackLabel: "No",
    side: "below",
    priceAxis: "ascending",
    quote: { label: "Yes" },
  });
  expect(yesAsks!.color).not.toBe(noAsks!.color);
  // Yes asked at 0.75 is no bid at 0.25.
  expect(yesAsks!.quote.price(0.75)).toBe(0.25);
  expect(noAsks!.quote.price(0.25)).toBe(0.75);
});

test("row orientation swaps the halves without changing what they draw", () => {
  const [yesAsks, noAsks] = marketPressureRow(
    control(),
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    "positive-above",
  ).bars;
  expect(yesAsks).toMatchObject({ side: "below", priceAxis: "descending" });
  expect(noAsks).toMatchObject({ side: "above", priceAxis: "ascending" });
});

test("a token's side of the row is drawn from its complement's track", () => {
  expect(pressureTrackForToken(market, YES)).toBe(NO);
  expect(pressureTrackForToken(market, NO)).toBe(YES);
  expect(pressureTrackForToken(market, "other" as TokenId)).toBeNull();
});
