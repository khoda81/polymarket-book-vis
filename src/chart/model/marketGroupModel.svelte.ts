import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { fetchRecorderHydration } from "@/recorder/ageRecorderClient";
import { ClobFeeScheduleResolver } from "@/domain/books/feeSchedule";
import {
  syncObservationPoints,
  type ObservationClock,
  type ObservationDescription,
  type ObservationPoint,
} from "@/domain/pressure/observationClock";
import {
  resolveMarketLifecycle,
  summarizeEventMarketStatus,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/domain/markets/marketLifecycle";
import { MarketState } from "@/domain/markets/marketState";
import { isActiveOrderMarket } from "@/domain/markets/marketTradability";
import {
  pressureScaleForToken,
  type ChartDefinition,
  type ChartMarketControl,
} from "@/chart/configuration/chartDefinition";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/rendering/colors/signedVolume";
import { hasRealOrders } from "@/chart/age/ageStripLayout";
import { agePressureSourceTokenForSemanticToken } from "@/chart/age/ageStripPressureProjection";
import { AgeStripPressureState } from "@/chart/age/ageStripPressureState";
import { LiveBookFeed } from "@/chart/live/liveBookFeed";
import type { LiveBookFeedCallbacks } from "@/chart/live/liveBookContracts";
import type { ConnectionStatus, ViewMode } from "@/domain/markets/chartState";
import { emptyTokenBook, type TokenBook } from "@/domain/books/orderBook";
import { ViewportCache } from "./viewportCache";
import type {
  FeeSchedule,
  FeeScheduleResolver,
} from "@/domain/books/feeSchedule";
import type { MarketId, PublicClient, TokenId } from "@polymarket/client";

export interface MarketGroupServices {
  readonly hydrate: typeof fetchRecorderHydration;
  readonly createFees: (
    client: PublicClient,
  ) => FeeScheduleResolver & Pick<ClobFeeScheduleResolver, "primeMarkets">;
  readonly createFeed: (
    client: PublicClient,
    callbacks: LiveBookFeedCallbacks,
  ) => Pick<LiveBookFeed, "getBook" | "start" | "destroy">;
}
const DEFAULT_SERVICES: MarketGroupServices = {
  hydrate: fetchRecorderHydration,
  createFees: (client) => new ClobFeeScheduleResolver(client),
  createFeed: (client, callbacks) => new LiveBookFeed(client, callbacks),
};
interface ViewportActivity {
  readonly key: string;
  readonly primaryTokens: ReadonlySet<TokenId>;
  readonly tokens: ReadonlySet<TokenId>;
  readonly feed: ReturnType<MarketGroupServices["createFeed"]>;
  readonly hydration: AbortController;
  ready: Promise<void>;
}

/** Metadata and recent CPU data outlive viewport surfaces and live feeds. */
export class MarketGroupModel {
  readonly pressure = new AgeStripPressureState();
  readonly activeTokens = new SvelteSet<TokenId>();
  readonly observationPointsByToken = new SvelteMap<string, ObservationPoint>();
  connectionStatus = $state<ConnectionStatus>("disconnected");
  bookRevision = $state(0);
  pressureRevision = $state(0);
  visibilityRevision = $state(0);
  recordingRevision = $state(0);
  private metadataRevision = $state(0);
  private source: ChartDefinition;
  private readonly feeSchedules: ReturnType<MarketGroupServices["createFees"]>;
  private readonly controlByTokenValue = new Map<string, ChartMarketControl>();
  private readonly unregisterObservationSource: () => void;
  private readonly unsubscribeMarkets: () => void;
  private readonly visibilityInitialized = new Set<TokenId>();
  private readonly books = new Map<TokenId, TokenBook>();
  private requestedTokens: readonly TokenId[] = [];
  private activity: ViewportActivity | null = null;
  private destroyed = false;
  private viewMode: ViewMode = "age";
  volumeScale = 4.5;

  constructor(
    private readonly client: PublicClient,
    private readonly observations: ObservationClock,
    definition: ChartDefinition,
    private readonly markets: MarketState,
    private readonly onfailure: (message: string) => void = () => undefined,
    private readonly services: MarketGroupServices = DEFAULT_SERVICES,
    private readonly cache: ViewportCache = new ViewportCache(),
  ) {
    this.source = definition;
    this.feeSchedules = services.createFees(client);
    this.updateDefinition(definition);
    this.unregisterObservationSource = observations.register({
      points: this.observationPointsByToken,
      describe: (tokenId) => this.describeObservation(tokenId),
    });
    this.unsubscribeMarkets = markets.subscribe(() => {
      this.refreshActiveTokens();
      void this.syncActivity().catch((error: unknown) =>
        this.reportFailure(error),
      );
    });
  }

  get definition(): ChartDefinition {
    this.metadataRevision;
    return this.source;
  }

  updateDefinition(definition: ChartDefinition): void {
    this.source = definition;
    this.feeSchedules.primeMarkets(
      definition.controls.map((control) => control.market),
    );
    this.controlByTokenValue.clear();
    for (const control of definition.controls) {
      this.controlByTokenValue.set(control.tokenId, control);
      const opposite = control.market.outcomes.no.tokenId;
      if (opposite) this.controlByTokenValue.set(opposite, control);
      this.markets.reconcile(control.market.id, control.lifecycle);
      const timestamp =
        this.markets.resolvedAtMs.get(control.market.id) ??
        control.resolutionMs;
      if (this.pressure.memory(control.tokenId))
        this.pressure.ensure(control.tokenId, timestamp);
      if (opposite && this.pressure.memory(opposite))
        this.pressure.ensure(opposite, timestamp);
    }
    this.metadataRevision++;
    this.pressureRevision++;
    this.refreshActiveTokens();
  }

  get visibilityByMarketId() {
    return new Map(
      this.definition.controls.map((control) => [
        control.market.id,
        this.visibilityFor(control.market.id),
      ]),
    );
  }
  get marketStatus() {
    return summarizeEventMarketStatus(
      this.definition.controls.map((control) =>
        this.lifecycleFor(control.market.id),
      ),
    );
  }

  getBook(tokenId: string): TokenBook | undefined {
    const id = this.knownTokenId(tokenId);
    return id
      ? (this.activity?.feed.getBook(id) ?? this.books.get(id))
      : undefined;
  }

  getFeeSchedule(tokenId: string): FeeSchedule {
    const id = this.knownTokenId(tokenId);
    if (!id) throw new Error(`unknown pressure token ${tokenId}`);
    return this.feeSchedules.scheduleForToken(id);
  }

  marketTokenName(tokenId: string): string {
    const control = this.controlForTokenValue(tokenId);
    if (!control) return tokenId;
    const tokenName =
      control.tokenId === tokenId
        ? control.market.outcomes.yes.label
        : control.market.outcomes.no.label;
    return `${tokenName} · ${control.title}`;
  }

  tokenName(tokenId: string): string | undefined {
    const control = this.controlForTokenValue(tokenId);
    if (!control) return undefined;
    if (control.tokenId === tokenId) return control.market.outcomes.yes.label;
    return control.market.outcomes.no.tokenId === tokenId
      ? control.market.outcomes.no.label
      : undefined;
  }

  marketName(tokenId: string): string | undefined {
    return this.controlForTokenValue(tokenId)?.title;
  }

  oppositeTokenId(tokenId: string): string | undefined {
    return (
      this.controlForTokenValue(tokenId)?.market.outcomes.no.tokenId ??
      undefined
    );
  }

  pressureColorScale(tokenId: string): SignedVolumeColorScale {
    const id = this.knownTokenId(tokenId);
    return id
      ? pressureScaleForToken(this.definition, id)
      : DEFAULT_SIGNED_VOLUME_COLOR_SCALE;
  }

  lifecycleFor(marketId: MarketId): MarketLifecycle {
    return this.markets.lifecycles.get(marketId)!;
  }
  visibilityFor(marketId: MarketId) {
    return this.markets.visibilityFor(marketId);
  }
  isTokenActive(tokenId: string): boolean {
    const id = this.knownTokenId(tokenId);
    return id !== null && this.activeTokens.has(id);
  }
  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.refreshObservations();
  }
  userSetMarketVisible(control: ChartMarketControl, visible: boolean): void {
    this.markets.userSetVisible(control.market.id, visible);
  }

  setViewport(primaryTokens: readonly TokenId[]): Promise<void> {
    this.requestedTokens = primaryTokens;
    return this.syncActivity();
  }

  private refreshActiveTokens(): void {
    this.activeTokens.clear();
    for (const control of this.source.controls)
      if (this.visibilityFor(control.market.id).kind === "visible")
        this.activeTokens.add(control.tokenId);
    this.visibilityRevision++;
  }

  private syncActivity(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const controls = this.source.controls.filter(
      (control) =>
        this.requestedTokens.includes(control.tokenId) &&
        this.activeTokens.has(control.tokenId),
    );
    const tokenIds = controls.flatMap((control) =>
      control.market.outcomes.no.tokenId
        ? [control.tokenId, control.market.outcomes.no.tokenId]
        : [control.tokenId],
    );
    const liveTokens = controls
      .filter(
        (control) =>
          this.lifecycleFor(control.market.id).kind === "live" &&
          isActiveOrderMarket(control.market),
      )
      .flatMap((control) =>
        control.market.outcomes.no.tokenId
          ? [control.tokenId, control.market.outcomes.no.tokenId]
          : [control.tokenId],
      );
    const key = `${tokenIds.toSorted().join(",")};${liveTokens.toSorted().join(",")}`;
    if (this.activity?.key === key) return this.activity.ready;
    const previous = this.activity;
    this.activity = null;
    previous?.hydration.abort();
    if (tokenIds.length === 0 && (previous || this.books.size > 0))
      this.retainViewportData(previous);
    previous?.feed.destroy();
    this.connectionStatus = "disconnected";
    this.pressureRevision++;
    if (tokenIds.length === 0) {
      this.refreshObservations();
      return Promise.resolve();
    }
    this.cache.forget(this);
    this.pressure.retain(new Set(tokenIds));
    for (const tokenId of this.books.keys())
      if (!tokenIds.includes(tokenId)) this.books.delete(tokenId);
    for (const control of controls) {
      this.pressure.ensure(control.tokenId, control.resolutionMs);
      if (control.market.outcomes.no.tokenId)
        this.pressure.ensure(
          control.market.outcomes.no.tokenId,
          control.resolutionMs,
        );
    }
    const activity: ViewportActivity = {
      key,
      primaryTokens: new Set(controls.map((control) => control.tokenId)),
      tokens: new Set(tokenIds),
      ready: Promise.resolve(),
      hydration: new AbortController(),
      feed: this.services.createFeed(this.client, {
        onConnectionStatus: (status) => {
          if (this.activity === activity) this.connectionStatus = status;
        },
        onBookUpdated: (tokenId, book, update) => {
          if (this.activity !== activity || !activity.tokens.has(tokenId))
            return;
          this.observations.advance(update.validThroughMs);
          this.books.set(tokenId, book);
          this.pressure.applyBookUpdate(
            tokenId,
            book,
            this.feeSchedules.scheduleForToken(tokenId),
            update,
          );
          this.bookRevision++;
          this.pressureRevision++;
          this.refreshObservations();
          if (this.visibilityInitialized.has(tokenId)) return;
          this.visibilityInitialized.add(tokenId);
          const control = this.controlByTokenValue.get(tokenId)!;
          if (
            tokenId === control.tokenId &&
            !hasRealOrders(book) &&
            this.lifecycleFor(control.market.id).kind === "live"
          )
            this.markets.autoHide(control.market.id, "hidden-empty");
        },
        onMarketResolved: (resolution) => {
          if (this.activity === activity) this.applyResolution(resolution);
        },
      }),
    };
    this.activity = activity;
    this.applyKnownResolutions(controls);
    this.refreshObservations();
    void this.services.hydrate(
      tokenIds,
      (hydration) => {
        if (this.activity !== activity) return;
        this.pressure.setRecordingCoverage(hydration.recordingSinceMsByToken);
        this.pressure.hydrate(
          hydration.pressureSnapshotsByToken,
          (id) => this.getBook(id),
          (id) => this.getFeeSchedule(id),
        );
        this.applyKnownResolutions(controls);
        this.advancePressureObservations(
          Object.keys(hydration.pressureSnapshotsByToken),
        );
        this.recordingRevision++;
        this.pressureRevision++;
        this.refreshObservations();
      },
      activity.hydration.signal,
    );
    activity.ready = (async () => {
      try {
        if (liveTokens.length === 0) return;
        await this.feeSchedules.prepareTokens(liveTokens);
        if (this.activity !== activity) return;
        await activity.feed.start(liveTokens);
      } catch (error) {
        if (this.activity === activity) {
          this.activity = null;
          activity.hydration.abort();
          this.retainViewportData(activity);
          activity.feed.destroy();
          this.refreshObservations();
          throw error;
        }
      }
    })();
    return activity.ready;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const previous = this.activity;
    this.activity = null;
    previous?.hydration.abort();
    previous?.feed.destroy();
    this.cache.forget(this);
    this.pressure.reset();
    this.books.clear();
    this.observationPointsByToken.clear();
    this.unregisterObservationSource();
    this.unsubscribeMarkets();
  }

  private retainViewportData(activity: ViewportActivity | null): void {
    const tokens = activity?.tokens ?? this.books.keys();
    let weight = 0;
    for (const tokenId of tokens) {
      weight++;
      const book = activity?.feed.getBook(tokenId) ?? this.books.get(tokenId);
      if (book) {
        // Other views can keep mutating the coordinator's canonical book.
        // The cached display must stay at its last observed geometry and time.
        const copy = emptyTokenBook();
        for (const side of ["usdToYes", "yesToUsd"] as const)
          for (const order of book[side].asOrders())
            copy[side].setLevel(order.price, order.take);
        this.books.set(tokenId, copy);
        weight += copy.usdToYes.size + copy.yesToUsd.size;
      }
      for (const run of this.pressure.memory(tokenId)?.renderRuns() ?? [])
        weight += 1 + run.frozenSteps.length;
    }
    this.cache.retain(this, weight, () => {
      this.pressure.reset();
      this.books.clear();
      this.pressureRevision++;
      this.bookRevision++;
    });
  }

  private reportFailure(error: unknown): void {
    this.onfailure(error instanceof Error ? error.message : String(error));
  }

  private describeObservation(tokenId: string): ObservationDescription {
    const control = this.controlForTokenValue(tokenId);
    if (!control) throw new Error(`observation source lost token ${tokenId}`);

    const opposite = control.tokenId !== tokenId;
    return {
      name: this.marketTokenName(tokenId),
      color: signedVolumeColor(
        opposite ? 1 : -1,
        this.pressureColorScale(control.tokenId),
      ),
    };
  }

  private advancePressureObservations(tokenIds: Iterable<string>): void {
    for (const tokenId of tokenIds) {
      const observedAtMs = this.pressure.observationTime(tokenId);
      if (observedAtMs !== undefined) this.observations.advance(observedAtMs);
    }
  }

  private refreshObservations(): void {
    syncObservationPoints(
      this.observationPointsByToken,
      this.currentObservationPoints(),
    );
  }

  private *currentObservationPoints(): Iterable<ObservationPoint> {
    if (this.viewMode !== "age") return;

    for (const control of this.definition.controls) {
      if (!this.activity?.primaryTokens.has(control.tokenId)) continue;
      for (const tokenId of [
        control.tokenId,
        control.market.outcomes.no.tokenId,
      ]) {
        if (!tokenId) continue;
        const observedAtMs = this.pressure.observationTime(tokenId);
        if (observedAtMs !== undefined) yield { tokenId, observedAtMs };
      }
    }
  }

  private applyResolution(resolution: MarketResolutionUpdate): void {
    if (
      resolution.resolvedAtMs !== null &&
      Number.isFinite(resolution.resolvedAtMs) &&
      resolution.resolvedAtMs >= 0
    )
      this.observations.advance(resolution.resolvedAtMs);
    for (const control of this.source.controls) {
      const opposite = control.market.outcomes.no.tokenId;
      if (
        control.market.conditionId !== resolution.conditionId &&
        !resolution.assetIds.includes(control.tokenId) &&
        !(opposite && resolution.assetIds.includes(opposite)) &&
        resolution.winningAssetId !== control.tokenId &&
        !(opposite && resolution.winningAssetId === opposite)
      )
        continue;
      const next = resolveMarketLifecycle(
        this.lifecycleFor(control.market.id),
        resolution,
        control.tokenId,
        opposite,
        control.market.outcomes.yes.label,
        control.market.outcomes.no.label,
      );
      if (next.kind === "resolved")
        this.markets.resolve(control.market.id, next, resolution.resolvedAtMs);
    }
    this.applyKnownResolutions(this.source.controls);
    this.pressureRevision++;
    this.refreshObservations();
  }

  private applyKnownResolutions(controls: readonly ChartMarketControl[]): void {
    for (const control of controls) {
      const lifecycle = this.lifecycleFor(control.market.id);
      if (
        lifecycle.kind !== "resolved" ||
        !this.activity?.primaryTokens.has(control.tokenId)
      )
        continue;
      this.applyResolvedPressure(
        control.tokenId,
        control.market.outcomes.no.tokenId,
        lifecycle.winningTokenId,
        this.markets.resolvedAtMs.get(control.market.id) ?? null,
      );
    }
  }

  private applyResolvedPressure(
    primaryTokenId: TokenId,
    oppositeTokenId: TokenId | null,
    winningTokenId: TokenId,
    resolvedAtMs: number | null,
  ): void {
    const unboundedSourceTokenId = agePressureSourceTokenForSemanticToken(
      primaryTokenId,
      oppositeTokenId,
      winningTokenId,
    );

    this.pressure.resolveSource(
      primaryTokenId,
      primaryTokenId === unboundedSourceTokenId,
      resolvedAtMs,
    );
    if (oppositeTokenId)
      this.pressure.resolveSource(
        oppositeTokenId,
        oppositeTokenId === unboundedSourceTokenId,
        resolvedAtMs,
      );
  }

  private knownTokenId(value: string): TokenId | null {
    const control = this.controlByTokenValue.get(value);
    if (!control) return null;
    if (control.tokenId === value) return control.tokenId;
    const oppositeTokenId = control.market.outcomes.no.tokenId;
    return oppositeTokenId === value ? oppositeTokenId : null;
  }

  private controlForTokenValue(value: string): ChartMarketControl | undefined {
    return this.controlByTokenValue.get(value);
  }
}
