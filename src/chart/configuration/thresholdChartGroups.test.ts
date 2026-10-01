import { expect, test } from "bun:test";
import type { Event, Market } from "@polymarket/client";
import { buildChartDefinition, pressureScaleForToken } from "./chartDefinition";
import {
  buildEventDetails,
  type EventDetails,
} from "../../domain/markets/eventDetails";
import { eventMarketGroups } from "./eventMarketGroups";
import { isActiveOrderMarket } from "../../domain/markets/marketTradability";
import { buildThresholdPalette } from "../../rendering/colors/thresholdColors";

interface WtiMarketRow {
  readonly id: string;
  readonly side: "HIGH" | "LOW";
  readonly title: string;
  readonly threshold: number;
  readonly yesPrice: number;
  readonly live?: boolean;
}

const WTI_ROWS: readonly WtiMarketRow[] = [
  {
    id: "3866508",
    side: "HIGH",
    title: "↑ $150",
    threshold: 0,
    yesPrice: 0.0005,
  },
  {
    id: "3866512",
    side: "HIGH",
    title: "↑ $110",
    threshold: 7,
    yesPrice: 0.013,
  },
  {
    id: "3866509",
    side: "HIGH",
    title: "↑ $105",
    threshold: 8,
    yesPrice: 0.047,
  },
  {
    id: "4690431",
    side: "HIGH",
    title: "↑ $100",
    threshold: 9,
    yesPrice: 0.275,
  },
  {
    id: "4951222",
    side: "HIGH",
    title: "↑ $95",
    threshold: 10,
    yesPrice: 0.9995,
  },
  {
    id: "4884203",
    side: "LOW",
    title: "↓ $90",
    threshold: 11,
    yesPrice: 0.215,
  },
  {
    id: "4063373",
    side: "LOW",
    title: "↓ $85",
    threshold: 12,
    yesPrice: 0.0305,
  },
  {
    id: "3866515",
    side: "LOW",
    title: "↓ $80",
    threshold: 13,
    yesPrice: 0.015,
  },
  {
    id: "3866516",
    side: "LOW",
    title: "↓ $70",
    threshold: 15,
    yesPrice: 0.003,
  },
  {
    id: "resolved-high",
    side: "HIGH",
    title: "↑ $105",
    threshold: 23,
    yesPrice: 1,
    live: false,
  },
  {
    id: "resolved-low",
    side: "LOW",
    title: "↓ $95",
    threshold: 31,
    yesPrice: 1,
    live: false,
  },
];

function wtiBundle(): EventDetails {
  const event = {
    id: "907966",
    slug: "what-price-will-wti-hit-in-september-2026",
    title: "What will WTI Crude Oil (WTI) hit in September 2026?",
    trading: {
      negRisk: false,
      negRiskAugmented: false,
      negRiskMarketId: null,
    },
    display: { sortBy: null },
    markets: WTI_ROWS.map(wtiMarket),
  } as unknown as Event;

  return buildEventDetails(event, {
    id: "907966",
    negRisk: false,
    negRiskAugmented: false,
    negRiskMarketId: null,
    markets: WTI_ROWS.map((row) => ({
      id: row.id,
      groupItemThreshold: row.threshold,
    })),
  });
}

function wtiMarket(row: WtiMarketRow): Market {
  const live = row.live !== false;
  return {
    id: row.id,
    question: `Will WTI hit ${row.title.slice(2)} (${row.side}) in September?`,
    groupItemTitle: row.title,
    conditionId: null,
    state: {
      active: true,
      closed: !live,
      acceptingOrders: live,
    },
    resolution: { umaResolutionStatus: live ? null : "resolved" },
    outcomes: {
      yes: {
        label: "Yes",
        tokenId: `yes-${row.id}`,
        price: String(row.yesPrice),
      },
      no: {
        label: "No",
        tokenId: `no-${row.id}`,
        price: String(1 - row.yesPrice),
      },
    },
  } as unknown as Market;
}

test("splits the live WTI HIGH and LOW ladders into independent palettes", () => {
  const bundle = wtiBundle();

  expect(bundle.event.trading).toMatchObject({
    negRisk: false,
    negRiskAugmented: false,
    negRiskMarketId: null,
  });
  expect(
    buildThresholdPalette(bundle.event, bundle.thresholdByMarketId),
  ).toBeNull();

  const groups = eventMarketGroups(bundle);
  expect(
    groups.map(({ key, label, defaultAgeRowOrientation }) => ({
      key,
      label,
      defaultAgeRowOrientation,
    })),
  ).toEqual([
    {
      key: "high",
      label: "↑ High thresholds",
      defaultAgeRowOrientation: "negative-above",
    },
    {
      key: "low",
      label: "↓ Low thresholds",
      defaultAgeRowOrientation: "positive-above",
    },
  ]);

  const expectedDirections = ["prefix", "suffix"] as const;
  groups.forEach((group, index) => {
    const liveEvent = {
      ...group.bundle.event,
      markets: group.bundle.event.markets.filter(isActiveOrderMarket),
    };
    const expected = buildThresholdPalette(
      liveEvent,
      group.bundle.thresholdByMarketId,
    );
    expect(expected?.direction).toBe(expectedDirections[index]);

    const definition = buildChartDefinition(group.bundle);
    for (const outcome of expected!.outcomes)
      expect(pressureScaleForToken(definition, outcome.yesTokenId)).toEqual(
        outcome.scale,
      );
  });
});

test("does not split neg-risk or ambiguously labelled events", () => {
  const bundle = wtiBundle();
  const negRiskBundle: EventDetails = {
    ...bundle,
    event: {
      ...bundle.event,
      trading: { ...bundle.event.trading, negRisk: true },
    },
  };
  expect(eventMarketGroups(negRiskBundle)).toHaveLength(1);

  const conflictingMarket = {
    ...bundle.event.markets[0]!,
    question: "Will WTI hit $150 (LOW) in September?",
  } as Market;
  const ambiguousBundle: EventDetails = {
    ...bundle,
    event: {
      ...bundle.event,
      markets: [conflictingMarket, ...bundle.event.markets.slice(1)],
    },
  };
  expect(eventMarketGroups(ambiguousBundle)).toHaveLength(1);
});
