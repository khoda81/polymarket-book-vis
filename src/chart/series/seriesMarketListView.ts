import {
  opacityReference,
  syncObservationPoints,
  type ObservationClock,
  type ObservationDescription,
  type ObservationPoint,
  type ObservationReference,
  type ObservationTime,
} from "@/domain/pressure/observationClock";
import { SvelteMap } from "svelte/reactivity";
import { signedVolumeColor } from "@/rendering/colors/signedVolume";
import { AgeStripClock } from "../age/ageStripClock";
import { AgeStripTooltip } from "../age/ageStripTooltip";
import { handleAgeStripTuningWheel } from "../age/ageStripInteraction";
import {
  AGE_TIME_GUTTER_PX,
  rasterizeCenteredAgeRow,
  type AgeStripGeometry,
} from "../age/ageStripLayout";
import { AgeStripPressureState } from "../age/ageStripPressureState";
import {
  agePressureSourceTokenForSemanticToken,
  agePressureSurface,
} from "../age/ageStripPressureProjection";
import type { AgeRowOrientation } from "../age/ageStripOrientation";
import { drawAgeRowRails } from "../age/ageStripRendering";
import { GpuPressureLayer, type GpuPressureRow } from "../age/gpuPressureLayer";
import { LiveBookFeed } from "../live/liveBookFeed";
import { fetchRecorderHydration } from "@/recorder/ageRecorderClient";
import {
  AGE_ROW_BAND_PX,
  ghostRefreshDelayMs,
} from "@/chart/age/ageStripTuning";
import type { AgeStripTuningStore } from "@/chart/age/ageStripTuningStore";
import {
  type PresentationTarget,
  PresentationCoordinator,
} from "@/chart/presentationCoordinator";
import {
  buildChartDefinition,
  defaultPressureScaleForMarket,
} from "@/chart/configuration/chartDefinition";
import { ClobFeeScheduleResolver } from "@/domain/books/feeSchedule";
import type { TokenBook } from "@/domain/books/orderBook";
import { FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT } from "@/domain/pressure/pressureField";
import {
  initialMarketLifecycle,
  resolveMarketLifecycle,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/domain/markets/marketLifecycle";
import {
  OrderBookPlotter,
  type ChartTheme,
  type Frame,
} from "@/rendering/renderer";
import { chartThemeForDarkMode } from "../chartTheme";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  type SignedVolumeColorScale,
} from "@/rendering/colors/signedVolume";
import {
  SERIES_VISIBLE_ROWS,
  SeriesEventPager,
  mergeSeriesEvents,
  seriesMarketRows,
  seriesCurrentRowIndex,
  type SeriesMarketRow,
  type SeriesPageDirection,
} from "@/domain/series/seriesMarkets";
import type { EventDetails } from "@/domain/markets/eventDetails";
import { isActiveOrderMarket } from "@/domain/markets/marketTradability";
import type { ConnectionStatus } from "@/domain/markets/chartState";
import type {
  ClobAssetId,
  ConditionId,
  Event,
  Market,
  PublicClient,
  Series,
  TokenId,
} from "@polymarket/client";

export const SERIES_ROW_HEIGHT_PX = AGE_ROW_BAND_PX;
const LEFT_PADDING_PX = AGE_TIME_GUTTER_PX;
export const SERIES_LABEL_GUTTER_PX = 120;
const RIGHT_PADDING_PX = SERIES_LABEL_GUTTER_PX;
const TOP_PADDING_PX = 0;
const BOTTOM_PADDING_PX = 0;
const SUBSCRIPTION_BUFFER_ROWS = 2;
const SERIES_REFRESH_MS = 30_000;

export interface SeriesMarketListRenderInput {
  readonly ageRowOrientation: AgeRowOrientation;
  readonly observationReference: ObservationReference;
  readonly volumePerCssPixel: number;
  readonly ghostHalfLifeMs: number;
}

export interface SeriesVisibleMarket {
  readonly row: SeriesMarketRow;
  readonly centerY: number;
  readonly lifecycle: MarketLifecycle;
}

export interface SeriesPagingState {
  readonly loading: boolean;
}

export interface SeriesMarketListViewOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onFollowingChanged?: (following: boolean) => void;
  readonly onEventsChanged?: () => void;
  readonly onVisibleMarketsChanged?: (
    markets: readonly SeriesVisibleMarket[],
  ) => void;
  readonly onPagingChanged?: (state: SeriesPagingState) => void;
  readonly onAnchorEventChanged?: (event: Event | null) => void;
  readonly onError?: (message: string) => void;
}

export class SeriesMarketListView implements PresentationTarget {
  private readonly plotter: OrderBookPlotter;
  private readonly resizeObserver: ResizeObserver;
  private readonly themeQuery: MediaQueryList;
  private readonly pressure = new AgeStripPressureState();
  private readonly feeSchedules: ClobFeeScheduleResolver;
  private readonly pressureLayer: GpuPressureLayer;
  private readonly ageClock: AgeStripClock;
  private readonly tooltip: AgeStripTooltip;
  private readonly onConnectionStatus: (status: ConnectionStatus) => void;
  private readonly onFollowingChanged: (following: boolean) => void;
  private readonly onEventsChanged: () => void;
  private readonly onAnchorEventChanged: (event: Event | null) => void;
  private readonly onError: (message: string) => void;
  private readonly resolutionByCondition = new Map<
    ConditionId,
    MarketResolutionUpdate
  >();
  private readonly resolutionByAsset = new Map<
    ClobAssetId,
    MarketResolutionUpdate
  >();
  private readonly bookCache = new Map<string, TokenBook>();
  private readonly scaleByToken = new Map<string, SignedVolumeColorScale>();
  private readonly marketByToken = new Map<string, Market>();
  private readonly hydratedTokens = new Set<string>();

  private theme: ChartTheme;
  private rows: SeriesMarketRow[] = [];
  private readonly details = new Map<string, EventDetails>();
  private readonly pager: SeriesEventPager;
  private readonly loading = new Set<SeriesPageDirection>();
  private readonly failedPages = new Set<SeriesPageDirection>();
  private scrollLoadDirection: SeriesPageDirection | null = null;
  private refreshTask: Promise<void> | null = null;
  private readonly onVisibleMarketsChanged: (
    markets: readonly SeriesVisibleMarket[],
  ) => void;
  private readonly onPagingChanged: (state: SeriesPagingState) => void;
  private visibleMarketsKey = "";
  private following = true;
  private programmaticScrollTop: number | null = null;
  private feed: LiveBookFeed | null = null;
  private feedGeneration = 0;
  private feedKey = "";
  private retainedPressureTokens = new Set<string>();
  private lastAnchorEventId: string | null = null;
  private clockTimer: number | undefined;
  private readonly unregisterObservationSource: () => void;
  private observationGeometry: AgeStripGeometry | null = null;
  private renderInput: SeriesMarketListRenderInput;
  private renderedOpacityTimeMs: ObservationTime | null = null;
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    pressureCanvas: HTMLCanvasElement,
    private readonly canvasWrap: HTMLElement,
    private readonly scrollContainer: HTMLElement,
    private readonly scrollContent: HTMLElement,
    private readonly client: PublicClient,
    private readonly observationPointsByToken: SvelteMap<
      string,
      ObservationPoint
    >,
    private readonly observations: ObservationClock,
    private readonly tuning: AgeStripTuningStore,
    private readonly presentation: PresentationCoordinator,
    series: Series,
    initialRenderInput: SeriesMarketListRenderInput,
    options: SeriesMarketListViewOptions = {},
  ) {
    this.renderInput = initialRenderInput;
    this.feeSchedules = new ClobFeeScheduleResolver(client);
    this.pager = new SeriesEventPager(client, series);
    this.pressureLayer = new GpuPressureLayer(pressureCanvas);
    this.onConnectionStatus = options.onConnectionStatus ?? (() => undefined);
    this.onFollowingChanged = options.onFollowingChanged ?? (() => undefined);
    this.onEventsChanged = options.onEventsChanged ?? (() => undefined);
    this.onVisibleMarketsChanged =
      options.onVisibleMarketsChanged ?? (() => undefined);
    this.onPagingChanged = options.onPagingChanged ?? (() => undefined);
    this.onAnchorEventChanged =
      options.onAnchorEventChanged ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = chartThemeForDarkMode(this.themeQuery.matches);

    this.plotter = new OrderBookPlotter(canvas);
    this.plotter.padding.l = LEFT_PADDING_PX;
    this.plotter.padding.r = RIGHT_PADDING_PX;
    this.plotter.padding.t = TOP_PADDING_PX;
    this.plotter.padding.b = BOTTOM_PADDING_PX;
    this.plotter.onPan = (fraction) => {
      const chartHeight = Math.max(
        1,
        this.plotter.height - TOP_PADDING_PX - BOTTOM_PADDING_PX,
      );
      this.scrollContainer.scrollTop -= fraction * chartHeight;
      this.loadAtScrollEdge(-fraction);
    };
    this.plotter.onResetZoom = () => this.followLive();

    this.ageClock = new AgeStripClock({
      canvasWrap,
      getViewMode: () => "age",
      getObservationTime: (tokenId) => this.pressure.observationTime(tokenId),
      getTiming: (tokenId) => this.pressure.timing(tokenId),
      getRowOrientation: () => this.renderInput.ageRowOrientation,
      getTokenName: (tokenId) => {
        const market = this.marketByToken.get(tokenId);
        if (!market) return tokenId;
        const tokenName =
          market.outcomes.yes.tokenId === tokenId
            ? market.outcomes.yes.label
            : market.outcomes.no.label;
        return `${tokenName} · ${marketDisplayName(market)}`;
      },
      getTokenColor: (tokenId, opposite) =>
        signedVolumeColor(
          opposite ? 1 : -1,
          this.scaleByToken.get(tokenId) ?? DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
        ),
    });
    this.unregisterObservationSource = observations.register({
      points: this.observationPointsByToken,
      describe: (tokenId) => this.describeObservation(tokenId),
    });
    this.tooltip = new AgeStripTooltip({
      getOpacityTime: () =>
        opacityReference(this.renderInput.observationReference),
      canvas,
      getViewMode: () => "age",
      getPressureBand: (tokenId, price, volume) =>
        this.pressure.bandAtPoint(tokenId, price, volume),
      getRowOrientation: () => this.renderInput.ageRowOrientation,
      getVolumePerCssPixel: () => this.renderInput.volumePerCssPixel,
      getGhostHalfLifeMs: () => this.renderInput.ghostHalfLifeMs,
      getTokenName: (tokenId) => {
        const market = this.marketByToken.get(tokenId);
        if (!market) return undefined;
        if (market.outcomes.yes.tokenId === tokenId)
          return market.outcomes.yes.label;
        return market.outcomes.no.tokenId === tokenId
          ? market.outcomes.no.label
          : undefined;
      },
      getMarketName: (tokenId) => {
        const market = this.marketByToken.get(tokenId);
        return market ? marketDisplayName(market) : undefined;
      },
      getPressureColorScale: (tokenId) =>
        this.scaleByToken.get(tokenId) ??
        this.scaleByToken.get(
          this.marketByToken.get(tokenId)?.outcomes.yes.tokenId ?? "",
        ) ??
        DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    });

    const height =
      TOP_PADDING_PX +
      BOTTOM_PADDING_PX +
      SERIES_VISIBLE_ROWS * SERIES_ROW_HEIGHT_PX;
    this.canvasWrap.style.height = `${height}px`;
    this.scrollContainer.style.height = `${height}px`;
    this.scrollContent.style.height = `${height}px`;
    this.scrollContainer.addEventListener("scroll", this.handleScroll, {
      passive: true,
    });
    this.scrollContainer.addEventListener("keydown", this.handleKeydown);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.requestDraw();
    });
    this.resizeObserver.observe(canvas);

    this.scrollContainer.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  updateRenderInputs(next: SeriesMarketListRenderInput): void {
    const previous = this.renderInput;
    this.renderInput = next;

    const orientationChanged =
      next.ageRowOrientation !== previous.ageRowOrientation;
    const tuningChanged =
      next.volumePerCssPixel !== previous.volumePerCssPixel ||
      next.ghostHalfLifeMs !== previous.ghostHalfLifeMs;
    const observationChanged = !sameObservationReference(
      next.observationReference,
      previous.observationReference,
    );

    if (orientationChanged) this.ageClock.refresh();

    const nextOpacityTimeMs = opacityReference(next.observationReference);
    const opacityNeedsDraw =
      observationChanged &&
      (this.renderedOpacityTimeMs === null ||
        nextOpacityTimeMs - this.renderedOpacityTimeMs >=
          ghostRefreshDelayMs(next.ghostHalfLifeMs));

    if (orientationChanged || tuningChanged || opacityNeedsDraw)
      this.requestDraw();
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled([
      this.loadPage("older"),
      this.loadPage("newer"),
    ]);
    if (this.destroyed) return;
    if (this.rows.length === 0) {
      const failure = results.find((result) => result.status === "rejected");
      throw failure?.status === "rejected"
        ? failure.reason
        : new Error("No binary markets were found in this series");
    }
    this.scheduleWindowRefresh();
    this.requestDraw();
  }

  retryLoading(): void {
    const failed = [...this.failedPages];
    this.failedPages.clear();
    for (const direction of failed) {
      if (this.atScrollEdge(direction)) {
        this.scrollLoadDirection = direction;
        this.continueScrollLoading();
      } else void this.loadPage(direction).catch(() => undefined);
    }
    if (failed.length === 0) void this.refreshEvents();
  }

  followLive(): void {
    this.scrollLoadDirection = null;
    this.setFollowing(true);
    this.scrollToCurrent();
    void this.refreshEvents();
    this.requestDraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feedGeneration++;
    this.feed?.destroy();
    this.feed = null;
    this.unregisterObservationSource();
    this.ageClock.destroy();
    this.tooltip.destroy();
    this.pressureLayer.destroy();
    if (this.clockTimer !== undefined) window.clearTimeout(this.clockTimer);
    this.presentation.cancel(this);
    this.resizeObserver.disconnect();
    this.plotter.destroy();
    this.scrollContainer.removeEventListener("wheel", this.handleWheel, true);
    this.scrollContainer.removeEventListener("scroll", this.handleScroll);
    this.scrollContainer.removeEventListener("keydown", this.handleKeydown);
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private readonly handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = chartThemeForDarkMode(event.matches);
    this.ageClock.refresh();
    this.requestDraw();
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (handleAgeStripTuningWheel(event, this.tuning)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    // Keep ordinary wheel scrolling native; the plotter must not zoom it.
    if (event.deltaY !== 0) this.loadAtScrollEdge(event.deltaY);
    event.stopImmediatePropagation();
  };

  private readonly handleKeydown = (event: KeyboardEvent) => {
    const direction =
      event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home"
        ? -1
        : event.key === "ArrowDown" ||
            event.key === "PageDown" ||
            event.key === "End" ||
            event.key === " "
          ? event.key === " " && event.shiftKey
            ? -1
            : 1
          : 0;
    if (direction !== 0) this.loadAtScrollEdge(direction);
  };

  private readonly handleScroll = () => {
    if (this.programmaticScrollTop === this.scrollContainer.scrollTop) {
      this.programmaticScrollTop = null;
      this.requestDraw();
      return;
    }
    this.programmaticScrollTop = null;
    this.setFollowing(
      Math.abs(this.scrollContainer.scrollTop - this.currentScrollTop()) < 1,
    );
    this.requestDraw();
    this.loadAtScrollEdge();
  };

  private loadAtScrollEdge(direction = 0): void {
    const requested =
      direction <= 0 && this.atScrollEdge("older")
        ? "older"
        : direction >= 0 && this.atScrollEdge("newer")
          ? "newer"
          : null;
    this.scrollLoadDirection =
      requested && this.pager.hasMore(requested) ? requested : null;
    if (this.scrollLoadDirection) {
      this.setFollowing(false);
      this.failedPages.delete(this.scrollLoadDirection);
      this.continueScrollLoading();
    }
  }

  private atScrollEdge(direction: SeriesPageDirection): boolean {
    const top = this.scrollContainer.scrollTop;
    const padding = SUBSCRIPTION_BUFFER_ROWS * SERIES_ROW_HEIGHT_PX;
    return direction === "older"
      ? top <= padding
      : top + this.scrollContainer.clientHeight >=
          this.scrollContainer.scrollHeight - padding;
  }

  private continueScrollLoading(): void {
    const direction = this.scrollLoadDirection;
    if (
      direction === null ||
      this.loading.size > 0 ||
      this.refreshTask !== null ||
      this.failedPages.has(direction)
    )
      return;
    if (!this.pager.hasMore(direction) || !this.atScrollEdge(direction)) {
      this.scrollLoadDirection = null;
      return;
    }
    this.scrollLoadDirection = null;
    const rowCount = this.rows.length;
    void this.loadPage(direction)
      .then(() => {
        // Empty or duplicate pages must not strand the user at an edge. A page
        // adding rows satisfies this gesture; further scrolling requests more.
        if (
          !this.destroyed &&
          !this.following &&
          this.rows.length === rowCount &&
          this.loading.size === 0 &&
          this.scrollLoadDirection === null &&
          this.pager.hasMore(direction)
        )
          this.scrollLoadDirection = direction;
        this.continueScrollLoading();
      })
      .catch(() => undefined);
  }

  private currentScrollTop(): number {
    const index = seriesCurrentRowIndex(
      this.rows,
      Date.now(),
      (row) =>
        isActiveOrderMarket(row.market) &&
        this.marketLifecycle(row.market).kind === "live",
    );
    const max = Math.max(
      0,
      this.rows.length * SERIES_ROW_HEIGHT_PX - this.plotter.height,
    );
    return Math.min(max, Math.max(0, index) * SERIES_ROW_HEIGHT_PX);
  }

  private scrollToCurrent(): void {
    this.scrollTo(this.currentScrollTop());
  }

  private scrollTo(top: number): void {
    const previous = this.scrollContainer.scrollTop;
    this.scrollContainer.scrollTop = top;
    if (previous !== this.scrollContainer.scrollTop)
      this.programmaticScrollTop = this.scrollContainer.scrollTop;
  }

  private setFollowing(value: boolean): void {
    if (this.following === value) return;
    this.following = value;
    this.onFollowingChanged(value);
  }

  private emitPagingState(): void {
    this.onPagingChanged({
      loading: this.loading.size > 0 || this.refreshTask !== null,
    });
  }

  private async loadPage(direction: SeriesPageDirection): Promise<void> {
    if (
      this.destroyed ||
      this.refreshTask !== null ||
      this.loading.has(direction) ||
      !this.pager.hasMore(direction)
    )
      return;
    this.loading.add(direction);
    this.emitPagingState();
    try {
      const details = await this.pager.load(direction);
      if (!this.destroyed) this.installEvents(details);
    } catch (error) {
      this.failedPages.add(direction);
      if (!this.destroyed)
        this.onError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.loading.delete(direction);
      if (!this.destroyed) {
        this.emitPagingState();
        this.requestDraw();
        // A scroll made during loading remains pending.
        this.continueScrollLoading();
      }
    }
  }

  private installEvents(loaded: readonly EventDetails[]): void {
    const scrollTop = this.scrollContainer.scrollTop;
    const anchor =
      this.rows[Math.floor(scrollTop / SERIES_ROW_HEIGHT_PX)]?.tokenId;
    const offset = scrollTop % SERIES_ROW_HEIGHT_PX;
    for (const detail of loaded) this.details.set(detail.event.id, detail);
    const events = mergeSeriesEvents(
      [...this.details.values()].map((detail) => detail.event),
    );
    this.rows = seriesMarketRows(events);
    this.feeSchedules.primeMarkets(
      loaded.flatMap((detail) => detail.event.markets),
    );

    for (const detail of loaded) {
      const definition = buildChartDefinition(detail);
      for (const [index, market] of detail.event.markets.entries()) {
        const primary = market.outcomes.yes.tokenId;
        if (!primary) continue;
        this.scaleByToken.set(
          primary,
          definition.pressureScales.get(primary) ??
            defaultPressureScaleForMarket(detail.event, index),
        );
        this.marketByToken.set(primary, market);
        const opposite = market.outcomes.no.tokenId;
        if (opposite) this.marketByToken.set(opposite, market);
      }
    }

    const height =
      Math.max(1, Math.min(SERIES_VISIBLE_ROWS, this.rows.length)) *
      SERIES_ROW_HEIGHT_PX;
    this.scrollContainer.style.height = `${height}px`;
    this.canvasWrap.style.height = `${height}px`;
    this.scrollContent.style.height = `${Math.max(height, this.rows.length * SERIES_ROW_HEIGHT_PX)}px`;
    if (this.following) this.scrollToCurrent();
    else if (anchor) {
      const index = this.rows.findIndex((row) => row.tokenId === anchor);
      if (index >= 0) this.scrollTo(index * SERIES_ROW_HEIGHT_PX + offset);
    }
    this.visibleMarketsKey = "";
    this.onEventsChanged();
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.destroyed) return;
    this.presentation.invalidate(this);
  }

  renderFrame(_frameTimeMs: DOMHighResTimeStamp): void {
    this.draw();
  }

  private draw(): void {
    if (this.destroyed) return;
    const scrollTop = this.scrollContainer.scrollTop;
    const height = this.plotter.height;
    const frame = this.plotter.beginFrame(
      this.theme,
      {
        xRange: { min: 0, max: 1 },
        yRange: { min: 0, max: SERIES_VISIBLE_ROWS },
      },
      { transparentBackground: true },
    );
    const firstIndex = Math.max(
      0,
      Math.floor(scrollTop / SERIES_ROW_HEIGHT_PX),
    );
    const lastIndex = Math.min(
      this.rows.length,
      Math.ceil((scrollTop + height) / SERIES_ROW_HEIGHT_PX),
    );
    const bufferedRows = this.rows.slice(
      Math.max(0, firstIndex - SUBSCRIPTION_BUFFER_ROWS),
      lastIndex + SUBSCRIPTION_BUFFER_ROWS,
    );
    const visibleRows = this.rows.slice(firstIndex, lastIndex);
    const retained = new Set<string>();
    for (const row of bufferedRows) {
      const { market, tokenId, deadlineMs } = row;
      retained.add(tokenId);
      this.pressure.ensure(tokenId, deadlineMs);
      const opposite = market.outcomes.no.tokenId;
      if (opposite) {
        retained.add(opposite);
        this.pressure.ensure(opposite, deadlineMs);
      }
      const lifecycle = this.marketLifecycle(market);
      if (lifecycle.kind === "resolved")
        this.applyResolvedPressure(tokenId, opposite, lifecycle.winningTokenId);
    }
    this.retainedPressureTokens = retained;
    this.pressure.retain(retained);
    for (const tokenId of this.bookCache.keys())
      if (!retained.has(tokenId)) this.bookCache.delete(tokenId);
    for (const tokenId of this.hydratedTokens)
      if (!retained.has(tokenId)) this.hydratedTokens.delete(tokenId);

    const bufferedTokens: TokenId[] = [];
    const hydratableTokens: string[] = [];
    for (const row of bufferedRows) {
      const { market, tokenId } = row;

      const lifecycle = this.marketLifecycle(market);
      const oppositeTokenId = market.outcomes.no.tokenId;
      hydratableTokens.push(tokenId);
      if (oppositeTokenId) hydratableTokens.push(oppositeTokenId);
      if (lifecycle.kind === "live" && isActiveOrderMarket(market)) {
        bufferedTokens.push(tokenId);
        if (oppositeTokenId) bufferedTokens.push(oppositeTokenId);
      }
    }
    void this.hydrateTokens(hydratableTokens);

    const gpuRows: GpuPressureRow[] = [];
    const dpr = window.devicePixelRatio || 1;
    const scaleY = Math.max(1, frame.canvas.height) / this.plotter.height;

    for (const row of visibleRows) {
      const { market, tokenId } = row;

      const key = tokenId;
      const scale = this.pressureScale(row.event, market);
      const primaryMemory = this.pressure.memory(key);
      const oppositeTokenId = market.outcomes.no.tokenId;
      const oppositeKey = oppositeTokenId ?? null;
      const oppositeMemory = oppositeKey
        ? this.pressure.memory(oppositeKey)
        : undefined;
      if (!primaryMemory && !oppositeMemory) continue;

      const geometry = this.rowGeometry(frame, row);
      gpuRows.push({
        key,
        topDevice: Math.round(geometry.topCss * scaleY),
        centerDevice: Math.round(geometry.centerCss * scaleY),
        bottomDevice: Math.round(geometry.bottomCss * scaleY),
        surfaces: [
          ...(primaryMemory
            ? [
                agePressureSurface(
                  key,
                  primaryMemory.renderDataRevision(),
                  primaryMemory.renderMaxPrice(),
                  primaryMemory.renderRuns(),
                  primaryMemory.renderCumulativeShares(),
                  (revision) =>
                    primaryMemory.renderFirstChangedRunSince(revision),
                  primaryMemory.renderCurrentValidThroughMs(),
                  this.pressure.renderExtents(key),
                  this.pressure.renderExtentRevision(key),
                  scale,
                  "primary",
                  this.renderInput.ageRowOrientation,
                ),
              ]
            : []),
          ...(oppositeMemory
            ? [
                agePressureSurface(
                  oppositeKey!,
                  oppositeMemory.renderDataRevision(),
                  oppositeMemory.renderMaxPrice(),
                  oppositeMemory.renderRuns(),
                  oppositeMemory.renderCumulativeShares(),
                  (revision) =>
                    oppositeMemory.renderFirstChangedRunSince(revision),
                  oppositeMemory.renderCurrentValidThroughMs(),
                  this.pressure.renderExtents(oppositeKey!),
                  this.pressure.renderExtentRevision(oppositeKey!),
                  scale,
                  "opposite",
                  this.renderInput.ageRowOrientation,
                ),
              ]
            : []),
        ],
      });
    }

    this.updateAgeOverlays(frame, visibleRows);
    this.pressureLayer.render({
      rows: gpuRows,
      viewport: { l: frame.viewport.l, width: frame.viewport.width },
      cssWidth: this.plotter.width,
      cssHeight: this.plotter.height,
      dpr,
      volumePerCssPixel: this.renderInput.volumePerCssPixel,
      ghostHalfLifeMs: this.renderInput.ghostHalfLifeMs,
      opacityTimeMs: opacityReference(this.renderInput.observationReference),
      background: this.theme.bg,
    });

    for (const row of visibleRows)
      drawAgeRowRails(
        frame,
        this.rowGeometry(frame, row),
        this.pressureScale(row.event, row.market),
      );
    this.updateVisibleMarkets(frame, visibleRows);
    this.updateAnchorEvent(visibleRows[0]?.event ?? null);
    this.refreshFeed(bufferedTokens);
    this.renderedOpacityTimeMs = opacityReference(
      this.renderInput.observationReference,
    );
  }

  private rowGeometry(frame: Frame, row: SeriesMarketRow) {
    return rasterizeCenteredAgeRow(
      (row.index + 0.5) * SERIES_ROW_HEIGHT_PX - this.scrollContainer.scrollTop,
      this.plotter.height,
      Math.max(1, frame.canvas.height),
    );
  }

  private updateVisibleMarkets(
    frame: Frame,
    rows: readonly SeriesMarketRow[],
  ): void {
    const markets = rows.map((row) => ({
      row,
      centerY: this.rowGeometry(frame, row).centerCss,
      lifecycle: this.marketLifecycle(row.market),
    }));
    const key = markets
      .map(
        ({ row, centerY, lifecycle }) =>
          `${row.tokenId}:${centerY}:${lifecycle.kind}:${lifecycle.kind === "resolved" ? lifecycle.winningTokenId : ""}`,
      )
      .join("|");
    if (key === this.visibleMarketsKey) return;
    this.visibleMarketsKey = key;
    this.onVisibleMarketsChanged(markets);
  }

  private updateAgeOverlays(
    frame: Frame,
    rows: readonly SeriesMarketRow[],
  ): void {
    const vp = frame.viewport;
    const geometry: AgeStripGeometry = {
      viewport: {
        l: vp.l,
        t: vp.t,
        width: vp.width,
        height: vp.height,
      },
      rows: rows.flatMap((row) => {
        const { market, tokenId } = row;

        const raster = this.rowGeometry(frame, row);

        return [
          {
            tokenId,
            oppositeTokenId: market.outcomes.no.tokenId
              ? market.outcomes.no.tokenId
              : undefined,
            centerY: raster.centerCss,
            topY: raster.topCss,
            bottomY: raster.bottomCss,
          },
        ];
      }),
      canvasWidth: vp.l + vp.width + this.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.plotter.padding.b,
    };
    this.observationGeometry = geometry;
    this.ageClock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);
    syncObservationPoints(
      this.observationPointsByToken,
      this.observationPoints(),
    );
  }

  private *observationPoints(): Iterable<ObservationPoint> {
    for (const row of this.observationGeometry?.rows ?? []) {
      for (const tokenId of [row.tokenId, row.oppositeTokenId]) {
        if (!tokenId) continue;
        const observedAtMs = this.pressure.observationTime(tokenId);
        if (observedAtMs !== undefined) yield { tokenId, observedAtMs };
      }
    }
  }

  private describeObservation(tokenId: string): ObservationDescription {
    const market = this.marketByToken.get(tokenId);
    if (!market) throw new Error(`observation source lost token ${tokenId}`);

    const primaryTokenId = market.outcomes.yes.tokenId;
    const opposite = primaryTokenId !== tokenId;
    const tokenName = opposite
      ? market.outcomes.no.label
      : market.outcomes.yes.label;
    return {
      name: `${tokenName} · ${marketDisplayName(market)}`,
      color: signedVolumeColor(
        opposite ? 1 : -1,
        this.scaleByToken.get(primaryTokenId ?? "") ??
          DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
      ),
    };
  }

  private pressureScale(event: Event, market: Market): SignedVolumeColorScale {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) {
      const cached = this.scaleByToken.get(tokenId);
      if (cached) return cached;
    }

    const index = Math.max(0, event.markets.indexOf(market));
    return defaultPressureScaleForMarket(event, index);
  }

  private marketLifecycle(market: Market): MarketLifecycle {
    const initial = initialMarketLifecycle(market);
    const conditionId = market.conditionId;
    const primary = market.outcomes.yes.tokenId;
    const opposite = market.outcomes.no.tokenId;
    if (!primary) return initial;

    const update =
      (conditionId ? this.resolutionByCondition.get(conditionId) : undefined) ??
      this.resolutionByAsset.get(primary) ??
      (opposite ? this.resolutionByAsset.get(opposite) : undefined);
    if (!update) return initial;

    return resolveMarketLifecycle(
      initial,
      update,
      primary,
      opposite,
      market.outcomes.yes.label,
      market.outcomes.no.label,
    );
  }

  private applyResolvedPressure(
    primaryTokenId: string,
    oppositeTokenId: string | null,
    winningTokenId: string,
  ): void {
    this.pressure.setExtents(primaryTokenId, []);
    if (oppositeTokenId) this.pressure.setExtents(oppositeTokenId, []);

    const sourceTokenId = agePressureSourceTokenForSemanticToken(
      primaryTokenId,
      oppositeTokenId,
      winningTokenId,
    );
    if (sourceTokenId)
      this.pressure.setExtents(sourceTokenId, [
        FULL_PERSISTENT_UNBOUNDED_PRESSURE_EXTENT,
      ]);
  }

  private refreshFeed(tokenIds: readonly TokenId[]): void {
    const unique = [...new Set(tokenIds)].sort();
    const key = unique.join(",");
    if (key === this.feedKey) return;
    this.feedKey = key;

    const generation = ++this.feedGeneration;
    this.feed?.destroy();
    this.feed = null;

    if (unique.length === 0) return;

    const feed = new LiveBookFeed(this.client, {
      onConnectionStatus: (status) => {
        if (!this.destroyed && generation === this.feedGeneration)
          this.onConnectionStatus(status);
      },
      onBookUpdated: (tokenId, book, update) => {
        if (this.destroyed || generation !== this.feedGeneration) return;
        this.observations.advance(update.validThroughMs);
        const key = tokenId;
        this.bookCache.set(key, book);
        this.pressure.applyBookUpdate(
          key,
          book,
          this.feeSchedules.scheduleForToken(tokenId),
          update,
        );
        this.requestDraw();
      },
      onMarketResolved: (resolution) => {
        if (this.destroyed || generation !== this.feedGeneration) return;
        if (
          resolution.resolvedAtMs !== null &&
          Number.isFinite(resolution.resolvedAtMs) &&
          resolution.resolvedAtMs >= 0
        )
          this.observations.advance(resolution.resolvedAtMs);
        this.resolutionByCondition.set(resolution.conditionId, resolution);
        for (const assetId of resolution.assetIds) {
          this.resolutionByAsset.set(assetId, resolution);
          this.bookCache.delete(assetId);
        }

        for (const row of this.rows) {
          const { market, tokenId } = row;
          const lifecycle = this.marketLifecycle(market);
          if (lifecycle.kind !== "resolved") continue;
          this.applyResolvedPressure(
            tokenId,
            market.outcomes.no.tokenId,
            lifecycle.winningTokenId,
          );
        }

        this.pressureLayer.invalidate();
        this.requestDraw();
      },
    });
    this.feed = feed;

    void this.feeSchedules
      .prepareTokens(unique)
      .then(async () => {
        if (this.destroyed || generation !== this.feedGeneration) {
          feed.destroy();
          return;
        }
        await feed.start(unique);
      })
      .catch((error) => {
        if (this.destroyed || generation !== this.feedGeneration) return;
        this.onConnectionStatus("disconnected");
        this.onError(error instanceof Error ? error.message : String(error));
      });
  }

  private async hydrateTokens(tokenIds: readonly string[]): Promise<void> {
    const fresh = [...new Set(tokenIds)].filter(
      (tokenId) => !this.hydratedTokens.has(tokenId),
    );
    if (fresh.length === 0) return;

    for (const tokenId of fresh) this.hydratedTokens.add(tokenId);
    await fetchRecorderHydration(fresh, (hydration) => {
      if (this.destroyed) return;

      this.pressure.setRecordingCoverage(hydration.recordingSinceMsByToken);
      this.pressure.hydrate(
        hydration.pressureSnapshotsByToken,
        (tokenId) =>
          this.bookCache.get(tokenId) ?? this.feed?.getBook(tokenId as TokenId),
        (tokenId) => this.feeSchedules.scheduleForToken(tokenId as TokenId),
      );
      this.pressure.retain(this.retainedPressureTokens);
      this.advancePressureObservations(this.retainedPressureTokens);
      this.pressureLayer.invalidate();
      this.ageClock.refresh();
      this.requestDraw();
    });
  }

  private advancePressureObservations(tokenIds: Iterable<string>): void {
    for (const tokenId of tokenIds) {
      const observedAtMs = this.pressure.observationTime(tokenId);
      if (observedAtMs !== undefined) this.observations.advance(observedAtMs);
    }
  }

  private updateAnchorEvent(event: Event | null): void {
    const id = event?.id ?? null;
    if (id === this.lastAnchorEventId) return;
    this.lastAnchorEventId = id;
    this.onAnchorEventChanged(event);
  }

  private refreshEvents(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    if (this.destroyed || this.loading.size > 0) return Promise.resolve();
    this.refreshTask = this.performRefresh().finally(() => {
      this.refreshTask = null;
      if (!this.destroyed) {
        this.emitPagingState();
        this.requestDraw();
        this.continueScrollLoading();
      }
    });
    this.emitPagingState();
    return this.refreshTask;
  }

  private async performRefresh(): Promise<void> {
    try {
      const details = await this.pager.refresh(
        this.following ? Date.now() : undefined,
      );
      if (!this.destroyed) {
        this.installEvents(details);
        this.emitPagingState();
      }
    } catch (error) {
      if (!this.destroyed)
        this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleWindowRefresh(): void {
    if (this.destroyed) return;
    this.clockTimer = window.setTimeout(() => {
      this.clockTimer = undefined;
      void this.refreshEvents().finally(() => this.scheduleWindowRefresh());
    }, SERIES_REFRESH_MS);
  }
}

function marketDisplayName(market: Market): string {
  return market.groupItemTitle ?? market.question ?? "(untitled)";
}

function sameObservationReference(
  a: ObservationReference,
  b: ObservationReference,
): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "unobserved" ||
      (b.kind === "observed" && a.newestMs === b.newestMs))
  );
}
