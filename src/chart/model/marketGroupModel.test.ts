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
import { PressureFrontierMemory } from "../../domain/pressure/pressureFrontierMemory";

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

function definition(
  firstMarketOrderState: Readonly<{
    active: boolean;
    acceptingOrders: boolean;
  }> = { active: true, acceptingOrders: true },
) {
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
        active: index === 0 ? firstMarketOrderState.active : true,
        closed: false,
        acceptingOrders:
          index === 0 ? firstMarketOrderState.acceptingOrders : true,
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
  chartDefinition = definition(),
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
  let recorderOnline = true;
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
      if (!recorderOnline) throw new Error("recorder offline");
      return { recordingSinceMsByToken: {}, pressureSnapshotsByToken: {} };
    },
  };
  const model = new MarketGroupModel(
    {} as never,
    observations,
    chartDefinition,
    markets,
    undefined,
    services,
  );
  return {
    model,
    markets,
    observations,
    feeds,
    hydration,
    disconnectRecorder: () => (recorderOnline = false),
  };
}

function recordedHistory(ids: readonly string[]) {
  const memory = new PressureFrontierMemory();
  memory.observeLevels([{ price: parsePrice("0.6"), shares: 100 }], 1_000);
  memory.updateLevels([{ price: parsePrice("0.6"), shares: 40 }], 2_000);
  return {
    recordingSinceMsByToken: Object.fromEntries(ids.map((id) => [id, 500])),
    pressureSnapshotsByToken: Object.fromEntries(
      ids.map((id) => [id, memory.snapshot()]),
    ),
  };
}

test("partial scrolling preserves hydrated history and recording age without requesting it again", async () => {
  const { model, feeds, hydration, disconnectRecorder } = harness();
  const [a, b] = model.definition.controls;
  try {
    await model.setViewport([a!.tokenId]);
    hydration[0]!.progress(recordedHistory(hydration[0]!.ids));
    const memory = model.pressure.memory(a!.tokenId)!;
    const snapshot = memory.snapshot();
    expect(memory.renderRuns()[0]!.frozenSteps.length).toBeGreaterThan(0);
    expect(model.pressure.memory(b!.tokenId)).toBeUndefined();
    await model.setViewport([b!.tokenId]);
    hydration[1]!.progress(recordedHistory(hydration[1]!.ids));
    expect(hydration[1]!.ids).toEqual([
      b!.tokenId,
      b!.market.outcomes.no.tokenId!,
    ]);
    expect(model.pressure.memory(a!.tokenId)).toBe(memory);
    disconnectRecorder();
    const revision = model.visibilityRevision;
    await model.setViewport([a!.tokenId]);
    expect(model.visibilityRevision).toBeGreaterThan(revision);
    model.userSetMarketVisible(a!, false);
    model.userSetMarketVisible(a!, true);
    await model.setViewport([]);
    expect(model.observationPointsByToken.size).toBe(0);
    await model.setViewport([a!.tokenId, b!.tokenId]);
    expect(hydration).toHaveLength(2);
    expect(feeds).toHaveLength(2);
    expect(hydration[0]!.signal.aborted).toBe(false);
    expect(model.pressure.memory(a!.tokenId)).toBe(memory);
    expect(memory.snapshot()).toEqual(snapshot);
    expect(model.pressure.timing(a!.tokenId)!.recordingSinceMs).toBe(500);
    expect(model.visibilityFor(a!.market.id)).toEqual({ kind: "visible" });
  } finally {
    model.destroy();
  }
});

test("offscreen feeds keep accumulating observed pressure without a reconnect or hydration", async () => {
  const { model, feeds, hydration } = harness();
  const control = model.definition.controls[0]!;
  try {
    await model.setViewport([control.tokenId]);
    const book = emptyTokenBook();
    book.yesToUsd.setLevel(parsePrice("0.6"), 100);
    feeds[0]!.callbacks.onBookUpdated(control.tokenId, book, {
      kind: "snapshot",
      validThroughMs: 1_000,
    });
    await model.setViewport([]);
    expect(feeds[0]!.closed).toBe(false);
    const fresh = emptyTokenBook();
    fresh.yesToUsd.setLevel(parsePrice("0.7"), 50);
    feeds[0]!.callbacks.onBookUpdated(control.tokenId, fresh, {
      kind: "snapshot",
      validThroughMs: 2_000,
    });
    expect(model.pressure.observationTime(control.tokenId)).toBe(
      observationTime(2_000),
    );
    expect(model.pressure.memory(control.tokenId)!.currentLevels()).toEqual([
      { price: parsePrice("0.7"), shares: 50 },
    ]);
    await model.setViewport([control.tokenId]);
    expect(model.getBook(control.tokenId)).toBe(fresh);
    expect(hydration).toHaveLength(1);
    expect(feeds).toHaveLength(1);
  } finally {
    model.destroy();
  }
});

test("history survives browsing more than eight cards with the recorder then unavailable", async () => {
  const cards = Array.from({ length: 12 }, () => harness());
  try {
    for (const card of cards) {
      await card.model.setViewport([
        card.model.definition.controls[0]!.tokenId,
      ]);
      card.hydration[0]!.progress(recordedHistory(card.hydration[0]!.ids));
      await card.model.setViewport([]);
      card.disconnectRecorder();
    }
    for (const card of cards) {
      const token = card.model.definition.controls[0]!.tokenId;
      const memory = card.model.pressure.memory(token)!;
      const before = memory.snapshot();
      await card.model.setViewport([token]);
      expect(card.hydration).toHaveLength(1);
      expect(card.model.pressure.memory(token)).toBe(memory);
      expect(memory.snapshot()).toEqual(before);
      expect(card.model.pressure.timing(token)!.recordingSinceMs).toBe(500);
    }
  } finally {
    for (const card of cards) card.model.destroy();
  }
});

test("hydration can finish offscreen but actual removal cancels it and rejects late results", async () => {
  const { model, hydration } = harness();
  const token = model.definition.controls[0]!.tokenId;
  await model.setViewport([token]);
  await model.setViewport([]);
  expect(hydration[0]!.signal.aborted).toBe(false);
  hydration[0]!.progress(recordedHistory(hydration[0]!.ids));
  await model.setViewport([token]);
  expect(model.pressure.timing(token)!.recordingSinceMs).toBe(500);
  expect(hydration).toHaveLength(1);
  model.destroy();
  expect(hydration[0]!.signal.aborted).toBe(true);
  hydration[0]!.progress(recordedHistory(hydration[0]!.ids));
  expect(model.pressure.memory(token)).toBeUndefined();
});

test("late fee preparation cannot resurrect a destroyed group", async () => {
  let finish!: () => void;
  const { model, feeds } = harness(
    new Promise<void>((resolve) => (finish = resolve)),
  );
  const pending = model.setViewport([model.definition.controls[0]!.tokenId]);
  const offscreen = model.setViewport([]);
  model.destroy();
  finish();
  await Promise.all([pending, offscreen]);
  expect(feeds[0]!.closed).toBe(true);
  expect(feeds[0]!.started).toHaveLength(0);
});

test("markets excluded from live-order feeds default hidden without being discarded", async () => {
  const { model, feeds } = harness(
    Promise.resolve(),
    definition({ active: false, acceptingOrders: true }),
  );
  const control = model.definition.controls[0]!;
  try {
    expect(model.lifecycleFor(control.market.id).kind).toBe("live");
    expect(model.visibilityFor(control.market.id)).toEqual({
      kind: "hidden",
      reason: "unavailable-default",
    });
    expect(model.activeTokens.has(control.tokenId)).toBe(false);

    await model.setViewport([control.tokenId]);
    expect(feeds).toHaveLength(0);

    model.userSetMarketVisible(control, true);
    expect(model.visibilityFor(control.market.id)).toEqual({ kind: "visible" });
    expect(model.activeTokens.has(control.tokenId)).toBe(true);
    expect(feeds).toHaveLength(0);
  } finally {
    model.destroy();
  }
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
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.closed).toBe(true);
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
