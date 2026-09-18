import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import type { EventBundle } from "./eventBundle";
import {
  buildChartDefinition,
  pressureScaleForToken,
} from "./chartDefinition";
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
        state: { active: true },
        outcomes: {
          yes: { tokenId: "yes-1" },
          no: { tokenId: "no-1" },
        },
      },
      {
        id: "m2",
        question: "Inactive?",
        state: { active: false },
        outcomes: {
          yes: { tokenId: "yes-2" },
          no: { tokenId: "no-2" },
        },
      },
    ],
  } as unknown as Event;

  return {
    event,
    rawMarkets: [],
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: [],
    },
    marketTitles: new Map([["m1", "First label"]]),
    marketIcons: new Map([["m1", "https://example.com/m1.png"]]),
    tokenNames: new Map([["yes-1", "Primary"]]),
    oppositeTokenNames: new Map([["yes-1", "Opposite"]]),
  };
}

test("chart definition contains only renderable active primary-token rows", () => {
  const definition = buildChartDefinition(fakeBundle());

  expect(definition.controls).toHaveLength(1);
  expect(definition.controls[0]).toMatchObject({
    marketId: "m1",
    tokenId: "yes-1",
    title: "First label",
    iconUrl: "https://example.com/m1.png",
    acceptingOrders: false,
    order: 0,
    resolutionMs: null,
    ageLabel: "First label",
    suppressAgeIdentity: false,
  });
  expect(definition.controls[0]?.dotColor).toBe(
    signedVolumeColor(
      1,
      pressureScaleForToken(definition, "yes-1"),
    ),
  );
  expect(definition.tokenNames.get("yes-1")).toBe("Primary");
  expect(definition.oppositeTokenNames.get("yes-1")).toBe("Opposite");
});
