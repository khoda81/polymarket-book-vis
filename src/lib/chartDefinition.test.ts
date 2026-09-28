import { expect, test } from "bun:test";
import type { Event, MarketId } from "@polymarket/client";
import type { EventDetails } from "./eventDetails";
import { buildChartDefinition, pressureScaleForToken } from "./chartDefinition";
import { signedVolumeColor } from "./signedVolume";
import { buildThresholdPalette } from "./thresholdColors";

function fakeBundle(): EventDetails {
  const event = {
    id: "event-1",
    title: "Example",
    trading: {
      negRisk: false,
      negRiskAugmented: false,
    },
    markets: [
      {
        id: "m1",
        question: "First?",
        groupItemTitle: "First label",
        icon: "https://example.com/m1.png",
        conditionId: null,
        state: { active: true, closed: false, acceptingOrders: true },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-1", price: "0.5" },
          no: { label: "No", tokenId: "no-1", price: "0.5" },
        },
      },
      {
        id: "m2",
        question: "Resolved?",
        conditionId: null,
        state: { active: true, closed: true, acceptingOrders: false },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-2", price: "1" },
          no: { label: "No", tokenId: "no-2", price: "0" },
        },
      },
      {
        id: "m3",
        question: "Awaiting resolution?",
        conditionId: null,
        state: { active: true, closed: true, acceptingOrders: false },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-3", price: "0.5" },
          no: { label: "No", tokenId: "no-3", price: "0.5" },
        },
      },
      {
        id: "m4",
        question: "Broken placeholder?",
        conditionId: null,
        state: { active: false, closed: false, acceptingOrders: true },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-4", price: null },
          no: { label: "No", tokenId: "no-4", price: null },
        },
      },
    ],
  } as unknown as Event;

  return {
    event,
    thresholdByMarketId: new Map(),
    resolutionMsByMarketId: new Map(),
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: [],
    },
  };
}

test("chart definition keeps tradable and resolved markets, not broken ones", () => {
  const definition = buildChartDefinition(fakeBundle());

  expect(definition.controls).toHaveLength(2);
  expect(definition.event.markets.map((market) => String(market.id))).toEqual([
    "m1",
    "m2",
  ]);
  expect(definition.controls[0]).toMatchObject({
    market: {
      id: "m1",
      conditionId: null,
    },
    tokenId: "yes-1",
    lifecycle: { kind: "live" },
    title: "First label",
    iconUrl: "https://example.com/m1.png",
    order: 0,
    resolutionMs: null,
    ageLabel: "First label",
    suppressAgeIdentity: false,
  });

  const control = definition.controls[0]!;
  expect(control.dotColor).toBe(
    signedVolumeColor(1, pressureScaleForToken(definition, control.tokenId)),
  );
  expect(control.market.outcomes.yes.label).toBe("Yes");
  expect(control.market.outcomes.no.label).toBe("No");

  expect(definition.controls[1]).toMatchObject({
    market: { id: "m2" },
    tokenId: "yes-2",
    lifecycle: {
      kind: "resolved",
      winningTokenId: "yes-2",
      winningOutcome: "Yes",
    },
  });
});

test("single-market wrapper metadata survives DOM recreation", () => {
  const title = "Putin meets with Iranian officials by December 31?";
  const event = {
    id: "event-2",
    title,
    trading: {
      negRisk: false,
      negRiskAugmented: false,
    },
    markets: [
      {
        id: "m1",
        question: title,
        conditionId: null,
        state: {
          active: true,
          closed: false,
          acceptingOrders: true,
        },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-1", price: "0.5" },
          no: { label: "No", tokenId: "no-1", price: "0.5" },
        },
      },
    ],
  } as unknown as Event;
  const endDate = "2026-12-31T23:59:00Z";
  const bundle: EventDetails = {
    event,
    thresholdByMarketId: new Map(),
    resolutionMsByMarketId: new Map([
      [event.markets[0]!.id, Date.parse(endDate)],
    ]),
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: [],
    },
  };

  const control = buildChartDefinition(bundle).controls[0];
  expect(control).toMatchObject({
    market: { id: "m1" },
    ageLabel: "",
    suppressAgeIdentity: true,
    order: 0,
    resolutionMs: Date.parse(endDate),
  });
});

interface GammaThresholdFixtureMarket {
  readonly id: string;
  readonly title: string;
  readonly threshold: number;
  readonly yesPrice: number;
  readonly live: boolean;
}

function gammaThresholdBundle(
  id: string,
  markets: readonly GammaThresholdFixtureMarket[],
): EventDetails {
  const event = {
    id,
    title: id,
    trading: { negRisk: false, negRiskAugmented: false },
    display: { sortBy: "ascending" },
    markets: markets.map((market) => ({
      id: market.id,
      question: market.title,
      groupItemTitle: market.title,
      conditionId: null,
      state: {
        active: true,
        closed: !market.live,
        acceptingOrders: market.live,
      },
      resolution: { umaResolutionStatus: market.live ? null : "resolved" },
      outcomes: {
        yes: {
          label: "Yes",
          tokenId: `yes-${market.id}`,
          price: String(market.yesPrice),
        },
        no: {
          label: "No",
          tokenId: `no-${market.id}`,
          price: String(1 - market.yesPrice),
        },
      },
    })),
  } as unknown as Event;

  return {
    event,
    thresholdByMarketId: new Map<MarketId, number>(
      markets.map((market) => [market.id as MarketId, market.threshold]),
    ),
    resolutionMsByMarketId: new Map(),
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: [],
    },
  };
}

function expectLiveThresholdPalette(bundle: EventDetails): void {
  expect(
    buildThresholdPalette(bundle.event, bundle.thresholdByMarketId),
  ).toBeNull();

  const liveEvent = {
    ...bundle.event,
    markets: bundle.event.markets.filter(
      (market) => market.state.acceptingOrders === true,
    ),
  };
  const expected = buildThresholdPalette(liveEvent, bundle.thresholdByMarketId);
  expect(expected).not.toBeNull();

  const definition = buildChartDefinition(bundle);
  for (const outcome of expected!.outcomes)
    expect(pressureScaleForToken(definition, outcome.yesTokenId)).toEqual(
      outcome.scale,
    );
}

test("uses live blockade thresholds when resolved appended slots break monotonicity", () => {
  // Live Gamma event 699735 has a coherent active ladder at slots 15-20, but
  // old July markets were reassigned to 21/22 with resolved NO prices.
  const bundle = gammaThresholdBundle("699735", [
    {
      id: "3128887",
      title: "September 30",
      threshold: 15,
      yesPrice: 0.0405,
      live: true,
    },
    {
      id: "4906127",
      title: "October 15",
      threshold: 16,
      yesPrice: 0.165,
      live: true,
    },
    {
      id: "3128888",
      title: "October 31",
      threshold: 17,
      yesPrice: 0.275,
      live: true,
    },
    {
      id: "4906128",
      title: "November 30",
      threshold: 18,
      yesPrice: 0.36,
      live: true,
    },
    {
      id: "3128886",
      title: "December 31",
      threshold: 19,
      yesPrice: 0.554,
      live: true,
    },
    {
      id: "4906129",
      title: "March 31",
      threshold: 20,
      yesPrice: 0.72,
      live: true,
    },
    {
      id: "2910486",
      title: "July 14",
      threshold: 21,
      yesPrice: 0,
      live: false,
    },
    {
      id: "2910435",
      title: "July 24",
      threshold: 22,
      yesPrice: 0,
      live: false,
    },
  ]);

  expectLiveThresholdPalette(bundle);
});

test("uses live ceasefire thresholds when a resolved market reuses an active slot", () => {
  // Live Gamma event 711714 gives both September 30 and the resolved
  // September 15 market slot 15; the still-trading 15-18 ladder is coherent.
  const bundle = gammaThresholdBundle("711714", [
    {
      id: "3399458",
      title: "September 30",
      threshold: 15,
      yesPrice: 0.9815,
      live: true,
    },
    {
      id: "4443001",
      title: "September 15",
      threshold: 15,
      yesPrice: 1,
      live: false,
    },
    {
      id: "3399459",
      title: "October 31",
      threshold: 16,
      yesPrice: 0.855,
      live: true,
    },
    {
      id: "3902370",
      title: "November 30",
      threshold: 17,
      yesPrice: 0.735,
      live: true,
    },
    {
      id: "3399468",
      title: "December 31",
      threshold: 18,
      yesPrice: 0.655,
      live: true,
    },
  ]);

  expectLiveThresholdPalette(bundle);
});
