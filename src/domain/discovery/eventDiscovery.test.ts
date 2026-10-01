import { expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import {
  discoverEvents,
  matchesDiscoveryFilters,
  parseDiscoveryTopics,
  validateDiscoveryFilters,
  type EventDiscoveryFilters,
} from "./eventDiscovery";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const FILTERS: EventDiscoveryFilters = {
  topics: ["iran", "middle-east"],
  minVolume: 10_000,
  minLiquidity: 0,
  recencyDays: 30,
  order: "createdAt",
};

function event(
  id: string,
  overrides: {
    tag?: string;
    volume?: string;
    liquidity?: string;
    createdAt?: string;
    active?: boolean;
    acceptingOrders?: boolean;
    closed?: boolean;
  } = {},
): Event {
  return {
    id,
    slug: `event-${id}`,
    createdAt: overrides.createdAt ?? "2026-09-22T00:00:00Z",
    metrics: {
      volume: overrides.volume ?? "20000",
      liquidity: overrides.liquidity ?? "5000",
    },
    state: { closed: overrides.closed ?? false },
    tags: [{ slug: overrides.tag ?? "iran" }],
    series: [],
    markets: [
      {
        state: {
          active: overrides.active ?? true,
          acceptingOrders: overrides.acceptingOrders ?? true,
        },
        outcomes: { yes: { tokenId: `token-${id}` } },
      },
    ],
  } as unknown as Event;
}

test("event discovery keeps only recent, open, tradeable, high-volume topics", () => {
  expect(matchesDiscoveryFilters(event("iran"), FILTERS, NOW)).toBe(true);
  expect(
    matchesDiscoveryFilters(
      event("middle", { tag: "middle-east" }),
      FILTERS,
      NOW,
    ),
  ).toBe(true);
  expect(
    matchesDiscoveryFilters(
      event("unrelated", { tag: "geopolitics" }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(event("small", { volume: "9999" }), FILTERS, NOW),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(
      event("old", { createdAt: "2026-08-01T00:00:00Z" }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(
      event("inactive", { acceptingOrders: false }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(
      event("disabled", { active: false, acceptingOrders: true }),
      FILTERS,
      NOW,
    ),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(event("closed", { closed: true }), FILTERS, NOW),
  ).toBe(false);
});

test("event discovery uses topic and volume filters and skips pinned/dismissed events", async () => {
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
  } as unknown as Parameters<typeof discoverEvents>[0];

  const found = await discoverEvents(
    client,
    FILTERS,
    new Set(["pinned", "dismissed"]),
    NOW,
  );

  expect(found.map((item) => String(item.id))).toEqual(["new"]);
  expect(request).toMatchObject({
    tagIds: [78, 154],
    tagMatch: "any",
    closed: false,
    volumeMin: 10_000,
    liquidityMin: 0,
    order: "createdAt",
    ascending: false,
  });
});

test("topics are customizable, normalized and deduplicated; blank means all", () => {
  expect(parseDiscoveryTopics(" Crypto, politics,crypto, ")).toEqual([
    "crypto",
    "politics",
  ]);
  expect(parseDiscoveryTopics("  ")).toEqual([]);
  expect(() => parseDiscoveryTopics("middle east")).toThrow("topic slugs");
  const crypto = event("crypto", { tag: "crypto" });
  expect(
    matchesDiscoveryFilters(crypto, { ...FILTERS, topics: ["crypto"] }, NOW),
  ).toBe(true);
  expect(matchesDiscoveryFilters(crypto, { ...FILTERS, topics: [] }, NOW)).toBe(
    true,
  );
  expect(matchesDiscoveryFilters(crypto, FILTERS, NOW)).toBe(false);
});

test("liquidity threshold and optional creation-date limit are applied locally", () => {
  const filters = { ...FILTERS, minLiquidity: 5_000 };
  expect(matchesDiscoveryFilters(event("enough"), filters, NOW)).toBe(true);
  expect(
    matchesDiscoveryFilters(event("low", { liquidity: "4999" }), filters, NOW),
  ).toBe(false);
  expect(
    matchesDiscoveryFilters(
      event("invalid", { liquidity: "NaN" }),
      filters,
      NOW,
    ),
  ).toBe(false);
  const old = event("old", { createdAt: "2020-01-01T00:00:00Z" });
  expect(matchesDiscoveryFilters(old, FILTERS, NOW)).toBe(false);
  expect(
    matchesDiscoveryFilters(old, { ...FILTERS, recencyDays: 0 }, NOW),
  ).toBe(true);
});

test("invalid numeric filters and sort values are rejected", () => {
  for (const invalid of [
    { minVolume: NaN },
    { minVolume: -1 },
    { minLiquidity: Infinity },
    { recencyDays: 366 },
    { recencyDays: -1 },
    { recencyDays: 0.5 },
    { order: "unknown" },
  ])
    expect(() =>
      validateDiscoveryFilters({
        ...FILTERS,
        ...invalid,
      } as EventDiscoveryFilters),
    ).toThrow();
});

test("all-topic discovery skips tag lookups, forwards sort/liquidity and caps added events", async () => {
  let request: Record<string, unknown> | undefined;
  const client = {
    fetchTag: async () => {
      throw new Error("No tag lookup expected");
    },
    listEvents: (options: Record<string, unknown>) => {
      request = options;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            items: Array.from({ length: 20 }, (_, i) =>
              event(String(i), { tag: "crypto" }),
            ),
          };
        },
      };
    },
  } as unknown as Parameters<typeof discoverEvents>[0];
  const found = await discoverEvents(
    client,
    { ...FILTERS, topics: [], minLiquidity: 1000, order: "volume24hr" },
    new Set(),
    NOW,
  );
  expect(found).toHaveLength(8);
  expect(request).not.toHaveProperty("tagIds");
  expect(request).not.toHaveProperty("tagMatch");
  expect(request).toMatchObject({ liquidityMin: 1000, order: "volume24hr" });
});

test("discovery bounds page scanning and skips events from pinned series", async () => {
  let pageCount = 0;
  const seriesEvent = {
    ...event("series"),
    series: [{ id: "pinned-series" }],
  } as unknown as Event;
  const client = {
    listEvents: () => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 10; i++) {
          pageCount++;
          yield {
            items: [seriesEvent, event(`closed-${i}`, { closed: true })],
          };
        }
      },
    }),
  } as unknown as Parameters<typeof discoverEvents>[0];
  expect(
    await discoverEvents(
      client,
      { ...FILTERS, topics: [] },
      new Set(),
      NOW,
      new Set(["pinned-series"]),
    ),
  ).toEqual([]);
  expect(pageCount).toBe(3);
});
