import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import type { EventBundle } from "./eventBundle";
import { buildChartDefinition, pressureScaleForToken } from "./chartDefinition";
import { signedVolumeColor } from "./signedVolume";

function fakeBundle(): EventBundle {
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
        state: { active: true, closed: false },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-1", price: "0.5" },
          no: { label: "No", tokenId: "no-1", price: "0.5" },
        },
      },
      {
        id: "m2",
        question: "Inactive?",
        conditionId: null,
        state: { active: false, closed: true },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-2", price: "1" },
          no: { label: "No", tokenId: "no-2", price: "0" },
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
    marketTitles: new Map([[event.markets[0]!.id, "First label"]]),
    marketIcons: new Map([
      [event.markets[0]!.id, "https://example.com/m1.png"],
    ]),
    tokenNames: new Map([
      [event.markets[0]!.outcomes.yes.tokenId!, "Primary"],
    ]),
    oppositeTokenNames: new Map([
      [event.markets[0]!.outcomes.yes.tokenId!, "Opposite"],
    ]),
  };
}

test("chart definition keeps resolved markets renderable", () => {
  const definition = buildChartDefinition(fakeBundle());

  expect(definition.controls).toHaveLength(2);
  expect(definition.controls[0]).toMatchObject({
    marketId: "m1",
    tokenId: "yes-1",
    oppositeTokenId: "no-1",
    conditionId: null,
    primaryOutcome: "Yes",
    oppositeOutcome: "No",
    lifecycle: { kind: "live" },
    title: "First label",
    iconUrl: "https://example.com/m1.png",
    acceptingOrders: false,
    order: 0,
    resolutionMs: null,
    ageLabel: "First label",
    suppressAgeIdentity: false,
  });
  const tokenId = definition.controls[0]!.tokenId;
  expect(definition.controls[0]?.dotColor).toBe(
    signedVolumeColor(1, pressureScaleForToken(definition, tokenId)),
  );
  expect(definition.tokenNames.get(tokenId)).toBe("Primary");
  expect(definition.oppositeTokenNames.get(tokenId)).toBe("Opposite");
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
  const bundle: EventBundle = {
    event,
    thresholdByMarketId: new Map(),
    resolutionMsByMarketId: new Map([[event.markets[0]!.id, Date.parse(endDate)]]),
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: [],
    },
    marketTitles: new Map(),
    marketIcons: new Map(),
    tokenNames: new Map(),
    oppositeTokenNames: new Map(),
  };

  const control = buildChartDefinition(bundle).controls[0];
  expect(control).toMatchObject({
    marketId: "m1",
    ageLabel: "",
    suppressAgeIdentity: true,
    order: 0,
    resolutionMs: Date.parse(endDate),
  });
});
