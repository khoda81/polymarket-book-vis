import { expect, test } from "bun:test";
import type { TokenId } from "@polymarket/client";
import type { ChartMarketControl } from "@/chart/configuration/chartDefinition";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "@/rendering/colors/signedVolume";
import { marketPressureRow, pressureTrackForToken } from "./marketPressureRows";

const YES = "yes-token" as TokenId;
const NO = "no-token" as TokenId;

function control(noTokenId: TokenId | null = NO): ChartMarketControl {
  return {
    market: {
      id: "market",
      outcomes: {
        yes: { label: "Yes", tokenId: YES },
        no: { label: "No", tokenId: noTokenId },
      },
    },
    tokenId: YES,
    title: "Will it rain?",
  } as unknown as ChartMarketControl;
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

test("a market without a no token draws only its yes asks", () => {
  const row = marketPressureRow(
    control(null),
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    "negative-above",
  );
  expect(row.bars.map((bar) => bar.track)).toEqual([YES]);
});

test("a token's side of the row is drawn from its complement's track", () => {
  expect(pressureTrackForToken(YES, NO, YES)).toBe(NO);
  expect(pressureTrackForToken(YES, NO, NO)).toBe(YES);
  expect(pressureTrackForToken(YES, NO, "other" as TokenId)).toBeNull();
  expect(pressureTrackForToken(YES, null, YES)).toBeNull();
});
