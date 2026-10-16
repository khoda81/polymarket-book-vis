import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { errorMessage } from "@/shared/errors";
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
import { signedVolumeColor } from "@/rendering/colors/signedVolume";
import { hasRealOrders } from "@/chart/age/ageStripLayout";
import type { AgeRowOrientation } from "@/chart/age/ageStripOrientation";
import type { PressureRow } from "@/chart/age/pressureRows";
import { marketPressureRow, pressureTrackForToken } from "./marketPressureRows";
import { AgeStripPressureState } from "@/chart/age/ageStripPressureState";
import { LiveBookFeed } from "@/chart/live/liveBookFeed";
import type { LiveBookFeedCallbacks } from "@/chart/live/liveBookContracts";
import type { ConnectionStatus, ViewMode } from "@/domain/markets/chartState";
import type { TokenBook } from "@/domain/books/orderBook";
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
interface LiveActivity {
  readonly key: string;
  readonly tokens: ReadonlySet<TokenId>;
  readonly feed: ReturnType<MarketGroupServices["createFeed"]>;
  ready: Promise<void>;
}

/** A group's initialized history and feeds live until the group is removed. */
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
  private readonly controlByMarketId = new Map<MarketId, ChartMarketControl>();
  private readonly controlByTokenValue = new Map<string, ChartMarketControl>();
  private readonly unregisterObservationSource: () => void;
  private readonly unsubscribeMarkets: () => void;
  private readonly visibilityInitialized = new Set<TokenId>();
  private readonly books = new Map<TokenId, TokenBook>();
  private readonly initializedTokens = new Set<TokenId>();
  private readonly requestedHistory = new Set<TokenId>();
  private readonly hydration = new AbortController();
  private requestedTokens: readonly TokenId[] = [];
  private activity: LiveActivity | null = null;
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
    // Reconcile facts before publishing the new definition. Subscribers may
    // run synchronously, so they must never see half-built token lookup maps
    // or controls whose lifecycle has not been initialized yet.
    for (const control of definition.controls)
      this.markets.reconcile(control.market.id, control.lifecycle);
    this.source = definition;
    this.feeSchedules.primeMarkets(
      definition.controls.map((control) => control.market),
    );
    this.controlByMarketId.clear();
    this.controlByTokenValue.clear();
    for (const control of definition.controls) {
      this.controlByMarketId.set(control.market.id, control);
      this.controlByTokenValue.set(control.tokenId, control);
      const opposite = control.market.outcomes.no.tokenId;
      if (opposite) this.controlByTokenValue.set(opposite, control);
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
    // Only removal from the group ends a token's data lifetime.
    this.pressure.retain(new Set(this.controlByTokenValue.keys()));
    for (const tokenId of this.books.keys())
      if (!this.controlByTokenValue.has(tokenId)) this.books.delete(tokenId);
    this.refreshActiveTokens();
    void this.syncActivity().catch((error: unknown) =>
      this.reportFailure(error),
    );
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

  lifecycleFor(marketId: MarketId): MarketLifecycle {
    return this.markets.lifecycles.get(marketId)!;
  }
  visibilityFor(marketId: MarketId) {
    const control = this.controlByMarketId.get(marketId);
    return this.markets.visibilityFor(
      marketId,
      control !== undefined && isActiveOrderMarket(control.market),
    );
  }
  /** Age rows for the requested viewport slice whose markets are shown. */
  pressureRows(orientation: AgeRowOrientation): PressureRow[] {
    return this.requestedTokens.flatMap((tokenId) => {
      const control = this.controlByTokenValue.get(tokenId);
      if (control?.tokenId !== tokenId || !this.activeTokens.has(tokenId))
        return [];
      return [
        marketPressureRow(
          control,
          pressureScaleForToken(this.definition, tokenId),
          orientation,
        ),
      ];
    });
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode = mode;
    this.refreshObservations();
  }
  userSetMarketVisible(control: ChartMarketControl, visible: boolean): void {
    this.markets.userSetVisible(control.market.id, visible);
  }

  setViewport(primaryTokens: readonly TokenId[]): Promise<void> {
    if (
      primaryTokens.length !== this.requestedTokens.length ||
      primaryTokens.some((id, index) => id !== this.requestedTokens[index])
    )
      this.visibilityRevision++;
    this.requestedTokens = primaryTokens;
    for (const tokenId of primaryTokens) this.initializedTokens.add(tokenId);
    this.refreshObservations();
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
    const controls = this.source.controls.filter((control) =>
      this.initializedTokens.has(control.tokenId),
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
    for (const control of controls) {
      this.pressure.ensure(control.tokenId, control.resolutionMs);
      if (control.market.outcomes.no.tokenId)
        this.pressure.ensure(
          control.market.outcomes.no.tokenId,
          control.resolutionMs,
        );
    }
    this.applyKnownResolutions(controls);
    this.loadHistory(tokenIds);
    const key = liveTokens.toSorted().join(",");
    if (this.activity?.key === key) return this.activity.ready;
    const previous = this.activity;
    this.activity = null;
    previous?.feed.destroy();
    this.connectionStatus = "disconnected";
    this.pressureRevision++;
    if (liveTokens.length === 0) {
      this.refreshObservations();
      return Promise.resolve();
    }
    const activity: LiveActivity = {
      key,
      tokens: new Set(liveTokens),
      ready: Promise.resolve(),
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
    this.refreshObservations();
    activity.ready = (async () => {
      try {
        await this.feeSchedules.prepareTokens(liveTokens);
        if (this.activity !== activity) return;
        await activity.feed.start(liveTokens);
      } catch (error) {
        if (this.activity === activity) {
          this.activity = null;
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
    this.hydration.abort();
    previous?.feed.destroy();
    this.pressure.reset();
    this.books.clear();
    this.observationPointsByToken.clear();
    this.unregisterObservationSource();
    this.unsubscribeMarkets();
  }

  private loadHistory(tokenIds: readonly TokenId[]): void {
    const missing = tokenIds.filter((id) => !this.requestedHistory.has(id));
    if (missing.length === 0) return;
    for (const id of missing) this.requestedHistory.add(id);
    void this.services
      .hydrate(
        missing,
        (hydration) => {
          if (this.destroyed) return;
          // Metadata refresh may remove a token while its request completes.
          const known = <T>(entries: Readonly<Record<string, T>>) =>
            Object.fromEntries(
              Object.entries(entries).filter(([id]) =>
                this.controlByTokenValue.has(id),
              ),
            );
          const snapshots = known(hydration.pressureSnapshotsByToken);
          this.pressure.setRecordingCoverage(
            known(hydration.recordingSinceMsByToken),
          );
          this.pressure.hydrate(
            snapshots,
            (id) => this.getBook(id),
            (id) => this.getFeeSchedule(id),
          );
          this.applyKnownResolutions(this.source.controls);
          this.advancePressureObservations(Object.keys(snapshots));
          this.recordingRevision++;
          this.pressureRevision++;
          this.refreshObservations();
        },
        this.hydration.signal,
      )
      .catch((error: unknown) => {
        if (!this.destroyed) this.reportFailure(error);
      });
  }

  private reportFailure(error: unknown): void {
    this.onfailure(errorMessage(error));
  }

  private describeObservation(tokenId: string): ObservationDescription {
    const control = this.controlForTokenValue(tokenId);
    if (!control) throw new Error(`observation source lost token ${tokenId}`);

    const opposite = control.tokenId !== tokenId;
    const outcome = opposite
      ? control.market.outcomes.no
      : control.market.outcomes.yes;
    return {
      name: `${outcome.label} · ${control.title}`,
      color: signedVolumeColor(
        opposite ? 1 : -1,
        pressureScaleForToken(this.definition, control.tokenId),
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
      if (
        !this.requestedTokens.includes(control.tokenId) ||
        !this.activeTokens.has(control.tokenId)
      )
        continue;
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
        !this.pressure.memory(control.tokenId)
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
    const unboundedSourceTokenId = pressureTrackForToken(
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
