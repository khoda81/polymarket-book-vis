import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { fetchRecorderHydration } from "@/recorder/ageRecorderClient";
import { ClobFeeScheduleResolver } from "@/domain/books/feeSchedule";
import {
  observationClock,
  syncObservationPoints,
  type ObservationDescription,
  type ObservationPoint,
} from "@/domain/pressure/observationClock";
import {
  resolveMarketLifecycle,
  summarizeEventMarketStatus,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/domain/markets/marketLifecycle";
import {
  loadMarketVisibility,
  persistStoredMarketVisibility,
  storedVisibilityForUserChoice,
  type MarketVisibility,
} from "@/domain/markets/marketVisibility";
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
import type { ConnectionStatus, ViewMode } from "@/domain/markets/chartState";
import type { TokenBook } from "@/domain/books/orderBook";
import type { FeeSchedule } from "@/domain/books/feeSchedule";
import type { MarketId, PublicClient, TokenId } from "@polymarket/client";

const VISIBLE_MARKET: MarketVisibility = { kind: "visible" };

/**
 * Reactive state for one rendered market group.
 *
 * Network/hydration/resolution inputs mutate this model exactly once. Svelte
 * consumers observe compact revisions and presentation state; the heavy
 * pressure frontier itself stays as an efficient mutable domain object.
 */
export class MarketGroupModel {
  readonly pressure = new AgeStripPressureState();
  readonly activeTokens = new SvelteSet<TokenId>();
  readonly visibilityByMarketId: SvelteMap<MarketId, MarketVisibility>;
  readonly lifecycleByMarketId: SvelteMap<MarketId, MarketLifecycle>;

  connectionStatus = $state<ConnectionStatus>("disconnected");
  bookRevision = $state(0);
  pressureRevision = $state(0);
  visibilityRevision = $state(0);
  recordingRevision = $state(0);
  readonly observationPointsByToken = new SvelteMap<string, ObservationPoint>();

  private readonly feeSchedules: ClobFeeScheduleResolver;
  private readonly feed: LiveBookFeed;
  private readonly controlByTokenValue = new Map<string, ChartMarketControl>();
  private readonly unregisterObservationSource: () => void;
  private lifecycle: "new" | "started" | "destroyed" = "new";
  private viewMode: ViewMode = "age";
  private readonly visibilityInitialized = new Set<TokenId>();

  constructor(
    client: PublicClient,
    readonly definition: ChartDefinition,
  ) {
    this.visibilityByMarketId = new SvelteMap(
      loadMarketVisibility(definition.controls),
    );
    this.lifecycleByMarketId = new SvelteMap(
      definition.controls.map((control) => [
        control.market.id,
        control.lifecycle,
      ]),
    );

    this.feeSchedules = new ClobFeeScheduleResolver(
      client,
      definition.controls.map((control) => control.market),
    );

    for (const control of definition.controls) {
      this.controlByTokenValue.set(control.tokenId, control);
      const oppositeTokenId = control.market.outcomes.no.tokenId;
      if (oppositeTokenId)
        this.controlByTokenValue.set(oppositeTokenId, control);

      if (
        (this.visibilityByMarketId.get(control.market.id) ?? VISIBLE_MARKET)
          .kind === "visible"
      )
        this.activeTokens.add(control.tokenId);
    }

    this.pressure.configure(
      definition.controls.flatMap((control) => {
        const rows = [
          {
            tokenId: control.tokenId,
            resolutionMs: control.resolutionMs,
          },
        ];
        const oppositeTokenId = control.market.outcomes.no.tokenId;
        if (oppositeTokenId)
          rows.push({
            tokenId: oppositeTokenId,
            resolutionMs: control.resolutionMs,
          });
        return rows;
      }),
    );

    for (const control of definition.controls) {
      if (control.lifecycle.kind !== "resolved") continue;
      this.applyResolvedPressure(
        control.tokenId,
        control.market.outcomes.no.tokenId,
        control.lifecycle.winningTokenId,
        null,
      );
    }

    this.feed = new LiveBookFeed(client, {
      onConnectionStatus: (status) => {
        this.connectionStatus = status;
      },
      onBookUpdated: (tokenId, book, update) => {
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
        if (hasRealOrders(book) || !this.activeTokens.has(tokenId)) return;
        this.autoHideToken(tokenId);
      },
      onMarketResolved: (resolution) => this.applyResolution(resolution),
    });

    this.unregisterObservationSource = observationClock(client).register({
      points: this.observationPointsByToken,
      describe: (tokenId) => this.describeObservation(tokenId),
    });
    this.refreshObservations();
  }

  get marketStatus() {
    return summarizeEventMarketStatus(this.lifecycleByMarketId.values());
  }

  getBook(tokenId: string): TokenBook | undefined {
    const id = this.knownTokenId(tokenId);
    return id ? this.feed.getBook(id) : undefined;
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
    return (
      this.lifecycleByMarketId.get(marketId) ??
      this.definition.controls.find((control) => control.market.id === marketId)
        ?.lifecycle ?? { kind: "live" }
    );
  }

  visibilityFor(marketId: MarketId): MarketVisibility {
    return this.visibilityByMarketId.get(marketId) ?? VISIBLE_MARKET;
  }

  isTokenActive(tokenId: string): boolean {
    const id = this.knownTokenId(tokenId);
    return id !== null && this.activeTokens.has(id);
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.refreshObservations();
  }

  userSetMarketVisible(control: ChartMarketControl, visible: boolean): void {
    const lifecycle = this.lifecycleFor(control.market.id);
    this.visibilityByMarketId.set(
      control.market.id,
      visible ? VISIBLE_MARKET : { kind: "hidden", reason: "user" },
    );
    persistStoredMarketVisibility(
      control.market.id,
      storedVisibilityForUserChoice(visible, lifecycle),
    );
    if (visible) this.activeTokens.add(control.tokenId);
    else this.activeTokens.delete(control.tokenId);
    this.visibilityRevision++;
    this.refreshObservations();
  }

  async start(): Promise<void> {
    if (this.lifecycle !== "new")
      throw new Error(`MarketGroupModel cannot start from ${this.lifecycle}`);
    this.lifecycle = "started";

    const allTokenIds = this.allTokenIds();
    const liveTokenIds = this.liveTokenIds();

    if (allTokenIds.length > 0)
      void fetchRecorderHydration(allTokenIds, (hydration) => {
        if (this.lifecycle === "destroyed") return;
        this.pressure.setRecordingCoverage(hydration.recordingSinceMsByToken);
        this.pressure.hydrate(
          hydration.pressureSnapshotsByToken,
          (tokenId) => this.getBook(tokenId),
          (tokenId) => this.getFeeSchedule(tokenId),
        );
        this.recordingRevision++;
        this.pressureRevision++;
        this.refreshObservations();
      });

    if (liveTokenIds.length > 0) {
      await this.feeSchedules.prepareTokens(liveTokenIds);
      await this.feed.start(liveTokenIds);
    }
  }

  destroy(): void {
    if (this.lifecycle === "destroyed") return;
    this.lifecycle = "destroyed";
    this.feed.destroy();
    this.unregisterObservationSource();
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

  private refreshObservations(): void {
    syncObservationPoints(
      this.observationPointsByToken,
      this.currentObservationPoints(),
    );
  }

  private *currentObservationPoints(): Iterable<ObservationPoint> {
    if (this.viewMode !== "age") return;

    for (const control of this.definition.controls) {
      if (!this.activeTokens.has(control.tokenId)) continue;
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

  private autoHideToken(tokenId: TokenId): void {
    const control = this.controlForTokenValue(tokenId);
    if (!control || control.tokenId !== tokenId) return;

    const lifecycle = this.lifecycleFor(control.market.id);
    if (lifecycle.kind !== "live") return;
    if (!this.activeTokens.delete(tokenId)) return;

    this.visibilityByMarketId.set(control.market.id, {
      kind: "hidden",
      reason: "empty-book",
    });
    persistStoredMarketVisibility(control.market.id, "hidden-empty");
    this.visibilityRevision++;
    this.refreshObservations();
  }

  private applyResolution(resolution: MarketResolutionUpdate): void {
    for (const control of this.definition.controls) {
      const oppositeTokenId = control.market.outcomes.no.tokenId;
      const belongsToMarket =
        (control.market.conditionId !== null &&
          control.market.conditionId === resolution.conditionId) ||
        resolution.assetIds.includes(control.tokenId) ||
        (oppositeTokenId !== null &&
          resolution.assetIds.includes(oppositeTokenId)) ||
        resolution.winningAssetId === control.tokenId ||
        (oppositeTokenId !== null &&
          resolution.winningAssetId === oppositeTokenId);
      if (!belongsToMarket) continue;

      const current = this.lifecycleFor(control.market.id);
      const next = resolveMarketLifecycle(
        current,
        resolution,
        control.tokenId,
        oppositeTokenId,
        control.market.outcomes.yes.label,
        control.market.outcomes.no.label,
      );
      if (next === current) continue;

      this.lifecycleByMarketId.set(control.market.id, next);
      this.activeTokens.add(control.tokenId);
      if (next.kind === "resolved") {
        this.applyResolvedPressure(
          control.tokenId,
          oppositeTokenId,
          next.winningTokenId,
          resolution.resolvedAtMs,
        );

        if (this.visibilityFor(control.market.id).kind === "visible") {
          this.visibilityByMarketId.set(control.market.id, {
            kind: "hidden",
            reason: "resolved-default",
          });
          persistStoredMarketVisibility(control.market.id, "hidden-resolved");
          this.activeTokens.delete(control.tokenId);
          this.visibilityRevision++;
        }
      }

      this.pressureRevision++;
    }
    this.refreshObservations();
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

  private allTokenIds(): TokenId[] {
    return [
      ...new Set(
        this.definition.controls.flatMap((control) => {
          const oppositeTokenId = control.market.outcomes.no.tokenId;
          return oppositeTokenId
            ? [control.tokenId, oppositeTokenId]
            : [control.tokenId];
        }),
      ),
    ];
  }

  private liveTokenIds(): TokenId[] {
    return [
      ...new Set(
        this.definition.controls
          .filter((control) => control.lifecycle.kind !== "resolved")
          .flatMap((control) => {
            const oppositeTokenId = control.market.outcomes.no.tokenId;
            return oppositeTokenId
              ? [control.tokenId, oppositeTokenId]
              : [control.tokenId];
          }),
      ),
    ];
  }
}
