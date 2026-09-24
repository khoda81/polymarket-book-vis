import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { buildEventBundle } from "./eventBundle";

function fakeEvent(): Event {
  return {
    id: "event-1",
    slug: "example-event",
    title: "Example",
    icon: "https://cdn.example/event.png?size=128",
    description: "Rules",
    display: { sortBy: "price" },
    markets: [
      {
        id: "m1",
        question: "First market?",
        groupItemTitle: "First",
        description: "Specific first-market rule.",
        icon: "https://cdn.example/event.png?size=32",
        state: {},
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-1", price: "0.7" },
          no: { label: "No", tokenId: "no-1", price: "0.3" },
        },
      },
      {
        id: "m2",
        question: "Second market?",
        groupItemTitle: "Second",
        description: "Rules",
        icon: "https://cdn.example/second.png",
        state: {},
        outcomes: {
          yes: { label: "Yes", tokenId: "yes-2", price: "0.2" },
          no: { label: "No", tokenId: "no-2", price: "0.8" },
        },
      },
    ],
  } as unknown as Event;
}

test("presentation uses normalized SDK metadata and dedupes artwork", () => {
  const event = fakeEvent();
  const bundle = buildEventBundle(event, { markets: [] });

  expect(bundle.presentation.description).toBeNull();
  expect(bundle.presentation.marketRules).toEqual([
    {
      marketId: event.markets[0]!.id,
      title: "First",
      body: "Specific first-market rule.",
    },
  ]);
});

test("raw Gamma data is reduced to missing market annotations", () => {
  const event = {
    ...fakeEvent(),
    subtitle: "Official figure at the deadline",
    description:
      "This market resolves according to the official published figure.",
    markets: fakeEvent().markets.map((market, index) => ({
      ...market,
      description:
        "This market resolves according to the official published figure.",
      state: {
        ...market.state,
        endDate: index === 0 ? "2026-12-31T23:59:00Z" : null,
      },
    })),
  } as Event;

  const bundle = buildEventBundle(event, {
    markets: [
      {
        id: "m1",
        groupItemThreshold: "0",
      },
      {
        id: "m2",
        groupItemThreshold: "1",
        endDateIso: "2027-01-02",
      },
    ],
  });

  expect(bundle.presentation.description).toEqual({
    preview: "Official figure at the deadline",
    body: "This market resolves according to the official published figure.",
  });
  expect(bundle.presentation.marketRules).toEqual([]);
  expect(bundle.thresholdByMarketId.get(event.markets[0]!.id)).toBe(0);
  expect(bundle.thresholdByMarketId.get(event.markets[1]!.id)).toBe(1);
  expect(bundle.resolutionMsByMarketId.get(event.markets[0]!.id)).toBe(
    Date.parse("2026-12-31T23:59:00Z"),
  );
  expect(bundle.resolutionMsByMarketId.get(event.markets[1]!.id)).toBe(
    Date.parse("2027-01-02"),
  );
});
