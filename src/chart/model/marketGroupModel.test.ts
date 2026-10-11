import { expect, test } from "bun:test";
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";
import type { Event, TokenId } from "@polymarket/client";
import { MarketState } from "../../domain/markets/marketState";
import {
  ObservationClock,
  observationTime,
} from "../../domain/pressure/observationClock";
import { NO_FEE_SCHEDULE } from "../../domain/books/feeSchedule";
import { emptyTokenBook } from "../../domain/books/orderBook";
import { parsePrice } from "../../domain/books/price";
import { buildChartDefinition } from "../configuration/chartDefinition";
import { buildEventDetails } from "../../domain/markets/eventDetails";
import type { LiveBookFeedCallbacks } from "../live/liveBookContracts";
import type { RecorderHydrationProgress } from "../../recorder/ageRecorderClient";
import type { MarketGroupServices } from "./marketGroupModel.svelte";
import { ViewportCache } from "./viewportCache";

// Exercise the real compiled runes model; no global $state/$derived shims.
plugin({
  name: "model-runes",
  setup(build) {
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => ({
      contents: compileModule(
        new Bun.Transpiler({ loader: "ts" }).transformSync(
          await Bun.file(path).text(),
        ),
        { filename: path, generate: "client" },
      ).js.code,
      loader: "js",
    }));
  },
});
const { MarketGroupModel } = await import("./marketGroupModel.svelte");

function definition() {
  const event = {
    id: "1038648",
    title: "Ceasefire",
    display: { sortBy: "ascending" },
    trading: { negRisk: false },
    markets: ["5130978", "4641065", "5447182"].map((id, index) => ({
      id,
      conditionId: `condition-${id}`,
      groupItemTitle: index === 0 ? "October 15" : "October 31",
      state: {
        active: true,
        closed: false,
        acceptingOrders: true,
        endDate: index === 0 ? "2026-10-16T03:59:00Z" : "2026-10-31T23:59:00Z",
      },
      trading: { feesEnabled: false },
      resolution: { umaResolutionStatus: null },
      outcomes: {
        yes: { tokenId: `yes-${id}`, label: "Yes", price: "0.6" },
        no: { tokenId: `no-${id}`, label: "No", price: "0.4" },
      },
    })),
  } as unknown as Event;
  return buildChartDefinition(buildEventDetails(event, {}));
}

function harness(
  feesReady: Promise<void> = Promise.resolve(),
  cache = new ViewportCache(),
) {
  const markets = new MarketState(null);
  const observations = new ObservationClock();
  const feeds: {
    callbacks: LiveBookFeedCallbacks;
    started: readonly TokenId[];
    closed: boolean;
  }[] = [];
  const hydration: {
    ids: readonly string[];
    progress: RecorderHydrationProgress;
    signal: AbortSignal;
  }[] = [];
  const services: MarketGroupServices = {
    createFees: () => ({
      primeMarkets() {},
      prepareTokens: () => feesReady,
      scheduleForToken: () => NO_FEE_SCHEDULE,
    }),
    createFeed: (_, callbacks) => {
      const entry = {
        callbacks,
        started: [] as readonly TokenId[],
        closed: false,
      };
      feeds.push(entry);
      return {
        getBook: () => undefined,
        start: async (ids) => {
          entry.started = ids;
        },
        destroy: () => {
          entry.closed = true;
        },
      };
    },
    hydrate: async (ids, progress, signal) => {
      hydration.push({ ids, progress: progress!, signal: signal! });
      return { recordingSinceMsByToken: {}, pressureSnapshotsByToken: {} };
    },
  };
  const model = new MarketGroupModel(
    {} as never,
    observations,
    definition(),
    markets,
    undefined,
    services,
    cache,
  );
  return {
    model,
    markets,
    observations,
    feeds,
    hydration,
    holdFees: () =>
      new Promise<() => void>((resolve) => {
        feesReady = new Promise<void>((finish) => resolve(finish));
      }),
  };
}

test("scrolling bounds active pressure/subscriptions and preserves recent CPU data", async () => {
  const { model, feeds, hydration } = harness();
  const [a, b] = model.definition.controls;
  try {
    await model.setViewport([a!.tokenId]);
    expect(feeds[0]!.started).toEqual([
      a!.tokenId,
      a!.market.outcomes.no.tokenId!,
    ]);
    expect(hydration[0]!.ids).toHaveLength(2);
    expect(model.pressure.memory(b!.tokenId)).toBeUndefined();
    await model.setViewport([b!.tokenId]);
    expect(feeds[0]!.closed).toBe(true);
    expect(hydration[0]!.signal.aborted).toBe(true);
    expect(model.pressure.memory(a!.tokenId)).toBeUndefined();
    expect(model.visibilityFor(a!.market.id)).toEqual({ kind: "visible" });
    // A retired recorder request may still complete; its data cannot recreate pressure.
    hydration[0]!.progress({
      recordingSinceMsByToken: { [a!.tokenId]: 1 },
      pressureSnapshotsByToken: {},
    });
    expect(model.pressure.memory(a!.tokenId)).toBeUndefined();
    await model.setViewport([]);
    expect(model.pressure.memory(b!.tokenId)).toBeDefined();
    expect(model.observationPointsByToken.size).toBe(0);
  } finally {
    model.destroy();
  }
});

test("returning draws last observed geometry before network readiness, without advancing its time", async () => {
  const { model, feeds, holdFees } = harness();
  const control = model.definition.controls[0]!;
  try {
    await model.setViewport([control.tokenId]);
    const book = emptyTokenBook();
    book.yesToUsd.setLevel(parsePrice("0.6"), 100);
    feeds[0]!.callbacks.onBookUpdated(control.tokenId, book, {
      kind: "snapshot",
      validThroughMs: 1_000,
    });
    const pressure = model.pressure.memory(control.tokenId)!.snapshot();
    await model.setViewport([]);
    // An overlapping view can keep mutating the original shared live book.
    book.yesToUsd.setLevel(parsePrice("0.6"), 200);
    const release = await holdFees();
    const pending = model.setViewport([control.tokenId]);
    expect(feeds[1]!.started).toHaveLength(0);
    expect(model.pressure.memory(control.tokenId)!.snapshot()).toEqual(
      pressure,
    );
    expect(model.pressure.observationTime(control.tokenId)).toBe(
      observationTime(1_000),
    );
    expect([
      ...model.getBook(control.tokenId)!.yesToUsd.asSellOrders(),
    ]).toEqual([{ price: parsePrice("0.6"), take: 100 }]);
    release();
    await pending;
    const fresh = emptyTokenBook();
    fresh.yesToUsd.setLevel(parsePrice("0.7"), 50);
    feeds[1]!.callbacks.onBookUpdated(control.tokenId, fresh, {
      kind: "snapshot",
      validThroughMs: 2_000,
    });
    expect(model.pressure.observationTime(control.tokenId)).toBe(
      observationTime(2_000),
    );
    expect(model.pressure.memory(control.tokenId)!.currentLevels()).toEqual([
      { price: parsePrice("0.7"), shares: 50 },
    ]);
  } finally {
    model.destroy();
  }
});

test("recent data is evicted by a dashboard-wide count and pressure-history budget", async () => {
  for (const cache of [new ViewportCache(1), new ViewportCache(8, 1)]) {
    const first = harness(Promise.resolve(), cache);
    const second = harness(Promise.resolve(), cache);
    const token = first.model.definition.controls[0]!.tokenId;
    try {
      await first.model.setViewport([token]);
      await first.model.setViewport([]);
      await second.model.setViewport([token]);
      await second.model.setViewport([]);
      expect(first.model.pressure.memory(token)).toBeUndefined();
      expect(first.model.observationPointsByToken.size).toBe(0);
      expect(first.feeds[0]!.closed).toBe(true);
      expect(
        first.model.visibilityFor(
          first.model.definition.controls[0]!.market.id,
        ),
      ).toEqual({ kind: "visible" });
    } finally {
      first.model.destroy();
      second.model.destroy();
    }
  }
});

test("late fee preparation cannot resurrect an offscreen or destroyed feed", async () => {
  let finish!: () => void;
  const { model, feeds } = harness(
    new Promise<void>((resolve) => (finish = resolve)),
  );
  const pending = model.setViewport([model.definition.controls[0]!.tokenId]);
  await model.setViewport([]);
  model.destroy();
  finish();
  await pending;
  expect(feeds[0]!.closed).toBe(true);
  expect(feeds[0]!.started).toHaveLength(0);
});

test("resolution survives viewport release, stale metadata and explicit revealing", async () => {
  const { model, markets, feeds } = harness();
  const control = model.definition.controls[0]!;
  try {
    await model.setViewport([control.tokenId]);
    feeds[0]!.callbacks.onMarketResolved({
      conditionId: control.market.conditionId!,
      assetIds: [control.tokenId, control.market.outcomes.no.tokenId!] as never,
      winningAssetId: control.tokenId as never,
      winningOutcome: "Yes",
      resolvedAtMs: 2_000,
    });
    expect(model.visibilityFor(control.market.id).kind).toBe("hidden");
    expect(model.lifecycleFor(control.market.id).kind).toBe("resolved");
    model.updateDefinition(definition());
    expect(model.lifecycleFor(control.market.id).kind).toBe("resolved");
    expect(markets.resolvedAtMs.get(control.market.id)).toBe(2_000);
    model.userSetMarketVisible(control, true);
    await model.setViewport([control.tokenId]);
    expect(
      model.pressure
        .memory(control.market.outcomes.no.tokenId!)!
        .isResolvedUnbounded(),
    ).toBe(true);
    expect(feeds.at(-1)!.started).toHaveLength(0);
    await model.setViewport([]);
    await model.setViewport([control.tokenId]);
    expect(
      model.pressure
        .memory(control.market.outcomes.no.tokenId!)!
        .isResolvedUnbounded(),
    ).toBe(true);
    expect(model.visibilityFor(control.market.id).kind).toBe("visible");
  } finally {
    model.destroy();
  }
});

test("an explicit visible choice survives empty books and a subsequent resolution", async () => {
  const { model, feeds } = harness();
  const control = model.definition.controls[0]!;
  try {
    model.userSetMarketVisible(control, true);
    await model.setViewport([control.tokenId]);
    feeds[0]!.callbacks.onBookUpdated(control.tokenId, emptyTokenBook(), {
      kind: "snapshot",
      validThroughMs: 1_000,
    });
    expect(model.visibilityFor(control.market.id).kind).toBe("visible");
    feeds[0]!.callbacks.onMarketResolved({
      conditionId: control.market.conditionId!,
      assetIds: [control.tokenId] as never,
      winningAssetId: control.tokenId as never,
      winningOutcome: "Yes",
      resolvedAtMs: 2_000,
    });
    expect(model.visibilityFor(control.market.id).kind).toBe("visible");
    expect(model.pressure.memory(control.tokenId)!.validThroughMs()).toBe(
      2_000,
    );
  } finally {
    model.destroy();
  }
});

test("observation points disappear offscreen while user choices remain shared", async () => {
  const { model, markets, feeds } = harness();
  const control = model.definition.controls[0]!;
  try {
    await model.setViewport([control.tokenId]);
    const book = emptyTokenBook();
    book.yesToUsd.setLevel(parsePrice("0.6"), 100);
    feeds[0]!.callbacks.onBookUpdated(control.tokenId, book, {
      kind: "snapshot",
      validThroughMs: 1_000,
    });
    expect(model.observationPointsByToken.size).toBe(1);
    await model.setViewport([]);
    expect(model.observationPointsByToken.size).toBe(0);
    markets.userSetVisible(control.market.id, false);
    expect(model.activeTokens.has(control.tokenId)).toBe(false);
    model.updateDefinition(definition());
    expect(model.visibilityFor(control.market.id)).toEqual({
      kind: "hidden",
      reason: "user",
    });
  } finally {
    model.destroy();
  }
});
