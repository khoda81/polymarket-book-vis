import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { buildEventBundle } from "./eventBundle";

function fakeEvent(): Event {
  return {
    id: "event-1",
    slug: "example-event",
    title: "Example",
    display: { sortBy: "price" },
    markets: [
      {
        id: "m1",
        question: "First market?",
        outcomes: {
          yes: { tokenId: "yes-1", price: "0.7" },
          no: { tokenId: "no-1", price: "0.3" },
        },
      },
      {
        id: "m2",
        question: "Second market?",
        outcomes: {
          yes: { tokenId: "yes-2", price: "0.2" },
          no: { tokenId: "no-2", price: "0.8" },
        },
      },
    ],
  } as unknown as Event;
}

test("presentation hides placeholder event descriptions and dedupes artwork", () => {
  const bundle = buildEventBundle(fakeEvent(), {
    icon: "https://cdn.example/event.png?size=128",
    description: "Rules",
    markets: [
      {
        id: "m1",
        groupItemTitle: "First",
        icon: "https://cdn.example/event.png?size=32",
        description: "Specific first-market rule.",
        outcomes: '["Yes","No"]',
        clobTokenIds: '["yes-1","no-1"]',
      },
      {
        id: "m2",
        groupItemTitle: "Second",
        icon: "https://cdn.example/second.png",
        description: "Rules",
        outcomes: '["Yes","No"]',
        clobTokenIds: '["yes-2","no-2"]',
      },
    ],
  });

  expect(bundle.presentation.description).toBeNull();
  expect(bundle.marketIcons.get("m1")).toBeUndefined();
  expect(bundle.marketIcons.get("m2")).toBe("https://cdn.example/second.png");
  expect(bundle.presentation.marketRules).toEqual([
    {
      marketId: "m1",
      title: "First",
      body: "Specific first-market rule.",
    },
  ]);
});

test("presentation uses subtitle as preview and omits duplicate market rules", () => {
  const common =
    "This market resolves according to the official published figure.";
  const bundle = buildEventBundle(fakeEvent(), {
    subtitle: "Official figure at the deadline",
    description: common,
    markets: [
      {
        id: "m1",
        description: common,
        outcomes: ["Primary", "Opposite"],
        clobTokenIds: ["yes-1", "no-1"],
      },
    ],
  });

  expect(bundle.presentation.description).toEqual({
    preview: "Official figure at the deadline",
    body: common,
  });
  expect(bundle.presentation.marketRules).toEqual([]);
  expect(bundle.tokenNames.get("yes-1")).toBe("Primary");
  expect(bundle.oppositeTokenNames.get("yes-1")).toBe("Opposite");
});
