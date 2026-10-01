import { expect, test } from "bun:test";
import type { Event, Market, MarketId } from "@polymarket/client";
import type { EventDetails } from "./eventDetails";
import { eventMarketGroups } from "./eventMarketGroups";

const ATTENDEE_ROWS = [
  { id: "3553880", title: "Donald Trump", threshold: 0 },
  { id: "3553885", title: "Pete Hegseth", threshold: 5 },
  { id: "3553886", title: "Abbas Araghchi", threshold: 6 },
  { id: "3553893", title: "Esmail Qaani", threshold: 13 },
  { id: "3553894", title: "Badr bin Hamad Al Busaidi", threshold: 14 },
  { id: "3902310", title: "Mohammed bin Salman", threshold: 19 },
] as const;

function attendeeBundle(): EventDetails {
  const markets = ATTENDEE_ROWS.map(
    (row, index) =>
      ({
        id: row.id,
        question: `Will ${row.title} attend a US x Iran diplomatic meeting by December 31, 2026?`,
        groupItemTitle: row.title,
        state: { active: true, closed: false, acceptingOrders: true },
        resolution: { umaResolutionStatus: null },
        outcomes: {
          yes: {
            label: "Yes",
            tokenId: `yes-${row.id}`,
            price: String(0.1 + index / 20),
          },
          no: {
            label: "No",
            tokenId: `no-${row.id}`,
            price: String(0.9 - index / 20),
          },
        },
      }) as unknown as Market,
  );
  const event = {
    id: "841086",
    slug: "who-will-attend-a-round-of-us-iran-peace-talks-by-december-31-20260812153824803",
    title: "Who will attend a round of US-Iran peace talks by December 31?",
    trading: { negRisk: false, negRiskAugmented: false },
    display: { sortBy: "price" },
    markets,
  } as unknown as Event;

  return {
    event,
    thresholdByMarketId: new Map<MarketId, number>(
      ATTENDEE_ROWS.map((row) => [row.id as MarketId, row.threshold]),
    ),
    resolutionMsByMarketId: new Map(),
    presentation: {
      iconUrl: null,
      description: null,
      marketRules: markets.map((market) => ({
        marketId: market.id,
        title: market.groupItemTitle!,
        body: `Rules for ${market.groupItemTitle}`,
      })),
    },
  };
}

test("uses the live peace-talk attendee ordering as three market groups", () => {
  const groups = eventMarketGroups(attendeeBundle());

  expect(
    groups.map((group) => ({
      key: group.key,
      label: group.label,
      orientation: group.defaultAgeRowOrientation,
      marketIds: group.bundle.event.markets.map((market) => String(market.id)),
      ruleIds: group.bundle.presentation.marketRules.map((rule) =>
        String(rule.marketId),
      ),
    })),
  ).toEqual([
    {
      key: "us-officials",
      label: "U.S. officials",
      orientation: "positive-above",
      marketIds: ["3553880", "3553885"],
      ruleIds: ["3553880", "3553885"],
    },
    {
      key: "iranian-officials",
      label: "Iranian officials",
      orientation: "positive-above",
      marketIds: ["3553886", "3553893"],
      ruleIds: ["3553886", "3553893"],
    },
    {
      key: "other-participants",
      label: "Other participants",
      orientation: "positive-above",
      marketIds: ["3553894", "3902310"],
      ruleIds: ["3553894", "3902310"],
    },
  ]);
});

test("does not apply attendee ordering to another event or incomplete metadata", () => {
  const bundle = attendeeBundle();
  expect(
    eventMarketGroups({
      ...bundle,
      event: { ...bundle.event, slug: "another-event" },
    }),
  ).toHaveLength(1);

  const thresholds = new Map(bundle.thresholdByMarketId);
  thresholds.delete(bundle.event.markets[0]!.id);
  expect(
    eventMarketGroups({ ...bundle, thresholdByMarketId: thresholds }),
  ).toHaveLength(1);
});
