import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import {
  discoverRegionalEvents,
  isRecentRegionalEvent,
} from "./regionalDiscovery";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const FILTERS = { minVolume: 10_000, recencyDays: 30 };

function event(
  id: string,
  overrides: {
    tag?: string;
    volume?: string;
    createdAt?: string;
    acceptingOrders?: boolean;
    closed?: boolean;
  } = {},
): Event {
  return {
    id,
    slug: `event-${id}`,
    createdAt: overrides.createdAt ?? "2026-09-22T00:00:00Z",
    metrics: { volume: overrides.volume ?? "20000" },
    state: { closed: overrides.closed ?? false },
    tags: [{ slug: overrides.tag ?? "iran" }],
    series: [],
    markets: [
      {
        state: { acceptingOrders: overrides.acceptingOrders ?? true },
        outcomes: { yes: { tokenId: `token-${id}` } },
      },
    ],
  } as unknown as Event;
}

test("regional discovery keeps only recent, open, tradeable, high-volume topics", () => {
  expect(isRecentRegionalEvent(event("iran"), FILTERS, NOW)).toBe(true);
  expect(
    isRecentRegionalEvent(
      event("middle", { tag: "middle-east" }),
      FILTERS,
      NOW,
    ),
  ).toBe(true);
  expect(
    isRecentRegionalEvent(
      event("unrelated", { tag: "geopolitics" }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    isRecentRegionalEvent(event("small", { volume: "9999" }), FILTERS, NOW),
  ).toBe(false);
  expect(
    isRecentRegionalEvent(
      event("old", { createdAt: "2026-08-01T00:00:00Z" }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    isRecentRegionalEvent(
      event("inactive", { acceptingOrders: false }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    isRecentRegionalEvent(event("closed", { closed: true }), FILTERS, NOW),
  ).toBe(false);
});

test("regional discovery uses topic and volume filters and skips pinned/dismissed events", async () => {
  let request: Record<string, unknown> | undefined;
  const client = {
    fetchTag: async ({ slug }: { slug: string }) => ({
      id: slug === "iran" ? "78" : "154",
    }),
    listEvents: (options: Record<string, unknown>) => {
      request = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { items: [event("pinned"), event("dismissed")] };
          yield { items: [event("new"), event("new")] };
        },
      };
    },
  } as unknown as Parameters<typeof discoverRegionalEvents>[0];

  const found = await discoverRegionalEvents(
    client,
    FILTERS,
    new Set(["dismissed"]),
    new Set(["event-pinned"]),
    NOW,
  );

  expect(found.map((item) => String(item.id))).toEqual(["new"]);
  expect(request).toMatchObject({
    tagIds: [78, 154],
    tagMatch: "any",
    closed: false,
    volumeMin: 10_000,
    order: "createdAt",
    ascending: false,
  });
});
