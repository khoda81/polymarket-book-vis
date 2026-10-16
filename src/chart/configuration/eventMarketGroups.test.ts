import { expect, test } from "bun:test";
import type {
  EventDetails,
  EventInfo,
} from "../../domain/markets/eventDetails";
import { eventMarket } from "../../shared/testing/eventMarkets";
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
  const event = {
    id: "841086",
    slug: "who-will-attend-a-round-of-us-iran-peace-talks-by-december-31-20260812153824803",
    title: "Who will attend a round of US-Iran peace talks by December 31?",
    trading: { negRisk: false, negRiskAugmented: false },
    display: { sortBy: "price" },
  } as unknown as EventInfo;

  return {
    event,
    presentation: { iconUrl: null, description: null },
    markets: ATTENDEE_ROWS.map((row) =>
      eventMarket(row.id, {
        title: row.title,
        groupItemTitle: row.title,
        threshold: row.threshold,
        rule: `Rules for ${row.title}`,
      }),
    ),
  };
}

test("uses the live peace-talk attendee ordering as three market groups", () => {
  const groups = eventMarketGroups(attendeeBundle());

  expect(
    groups.map((group) => ({
      key: group.key,
      label: group.label,
      orientation: group.defaultAgeRowOrientation,
      marketIds: group.bundle.markets.map((market) => String(market.id)),
      rules: group.bundle.markets.map((market) => market.rule),
    })),
  ).toEqual([
    {
      key: "us-officials",
      label: "U.S. officials",
      orientation: "positive-above",
      marketIds: ["3553880", "3553885"],
      rules: ["Rules for Donald Trump", "Rules for Pete Hegseth"],
    },
    {
      key: "iranian-officials",
      label: "Iranian officials",
      orientation: "positive-above",
      marketIds: ["3553886", "3553893"],
      rules: ["Rules for Abbas Araghchi", "Rules for Esmail Qaani"],
    },
    {
      key: "other-participants",
      label: "Other participants",
      orientation: "positive-above",
      marketIds: ["3553894", "3902310"],
      rules: [
        "Rules for Badr bin Hamad Al Busaidi",
        "Rules for Mohammed bin Salman",
      ],
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

  const [first, ...rest] = bundle.markets;
  expect(
    eventMarketGroups({
      ...bundle,
      markets: [{ ...first!, threshold: null }, ...rest],
    }),
  ).toHaveLength(1);
});
