import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import type { EventDetails } from "./eventBundle";
import { buildChartDefinition, pressureScaleForToken } from "./chartDefinition";
import { signedVolumeColor } from "./signedVolume";

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
  };
}

test("chart definition keeps resolved markets renderable", () => {
  const definition = buildChartDefinition(fakeBundle());

  expect(definition.controls).toHaveLength(2);
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
