import { AgeStripClock } from "./ageStripClock";
import { AgeStripTooltip } from "./ageStripTooltip";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import {
  AGE_TIME_GUTTER_PX,
  rowRasterGeometry,
  type AgeStripGeometry,
} from "./ageStripLayout";
import { AgeStripPressureState } from "./ageStripPressureState";
import {
  drawAgeRowRails,
  drawPressureMemoryStrip,
  drawResolvedMarketStrip,
} from "./ageStripRendering";
import { LiveBookFeed } from "./liveBookFeed";
import { fetchRecorderHydration } from "@/lib/ageRecorderClient";
import {
  getAgeStripTuning,
  ghostRefreshDelayMs,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import { defaultPressureScaleForMarket } from "@/lib/chartDefinition";
import type { TokenBook } from "@/lib/orderBook";
import {
  initialMarketLifecycle,
  resolveMarketLifecycle,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/lib/marketLifecycle";
import { OrderBookPlotter, type ChartTheme, type Frame } from "@/lib/renderer";
import { chartThemeForDarkMode } from "./chartTheme";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import {
  SERIES_ROW_HEIGHT_PX,
  SERIES_VISIBLE_ROWS,
  SERIES_WINDOW_ROWS,
  inferSeriesCadenceMs,
  loadSeriesEventsAround,
  timedSeriesEvent,
  type TimedSeriesEvent,
} from "@/lib/seriesTimeline";
import type { ConnectionStatus } from "@/lib/chartState";
import type {
  Event,
  Market,
  PublicClient,
  Series,
  TokenId,
} from "@polymarket/client";

const LEFT_PADDING_PX = AGE_TIME_GUTTER_PX;
const RIGHT_PADDING_PX = 108;
const TOP_PADDING_PX = 0;
const BOTTOM_PADDING_PX = 0;
const TIMELINE_RELATIVE_GUTTER_PX = 42;
const SUBSCRIPTION_BUFFER_ROWS = 2;
const WINDOW_RELOAD_FRACTION = 0.45;

export interface SeriesTimelineViewOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onFollowingChanged?: (following: boolean) => void;
  readonly onWindowChanged?: (eventCount: number) => void;
  readonly onAnchorEventChanged?: (event: Event | null) => void;
  readonly onError?: (message: string) => void;
}

export class SeriesTimelineView {
  private readonly plotter: OrderBookPlotter;
  private readonly resizeObserver: ResizeObserver;
  private readonly themeQuery: MediaQueryList;
  private readonly pressure = new AgeStripPressureState();
  private readonly ageClock: AgeStripClock;
  private readonly tooltip: AgeStripTooltip;
  private readonly unsubscribeTuning: () => void;
  private readonly onConnectionStatus: (status: ConnectionStatus) => void;
  private readonly onFollowingChanged: (following: boolean) => void;
  private readonly onWindowChanged: (eventCount: number) => void;
  private readonly onAnchorEventChanged: (event: Event | null) => void;
  private readonly onError: (message: string) => void;
  private readonly resolutionByCondition = new Map<
    string,
    MarketResolutionUpdate
  >();
  private readonly resolutionByAsset = new Map<
    string,
    MarketResolutionUpdate
  >();
  private readonly bookCache = new Map<string, TokenBook<string>>();
  private readonly scaleByToken = new Map<string, SignedVolumeColorScale>();
  private readonly tokenNameByToken = new Map<string, string>();
  private readonly oppositeTokenNameByToken = new Map<string, string>();
  private readonly absoluteTimeLabelByStart = new Map<number, string>();
  private readonly hydratedTokens = new Set<string>();

  private theme: ChartTheme;
  private rows: TimedSeriesEvent[];
  private cadenceMs: number;
  private userOffsetMs = 0;
  private following = true;
  private feed: LiveBookFeed | null = null;
  private feedGeneration = 0;
  private feedKey = "";
  private loadGeneration = 0;
  private loadedCenterMs: number | null = null;
  private loadedMinStartMs: number | null = null;
  private loadedMaxStartMs: number | null = null;
  private loadingCenterMs: number | null = null;
  private lastEdgeRefreshMs = 0;
  private lastAnchorEventId: string | null = null;
  private clockTimer: number | undefined;
  private ghostRefreshTimer: number | undefined;
  private raf: number | null = null;
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly canvasWrap: HTMLElement,
    private readonly client: PublicClient,
    private readonly series: Series,
    options: SeriesTimelineViewOptions = {},
  ) {
    const seedEvents = [...(series.events ?? [])];
    this.cadenceMs = inferSeriesCadenceMs(seedEvents, series.recurrence);
    this.rows = seedEvents
      .map((event) => timedSeriesEvent(event, this.cadenceMs))
      .filter((row): row is TimedSeriesEvent => row !== null);
    this.onConnectionStatus = options.onConnectionStatus ?? (() => undefined);
    this.onFollowingChanged = options.onFollowingChanged ?? (() => undefined);
    this.onWindowChanged = options.onWindowChanged ?? (() => undefined);
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
      this.panByCssPixels(fraction * chartHeight);
    };
    this.plotter.onResetZoom = () => this.followLive();

    this.ageClock = new AgeStripClock({
      canvasWrap,
      getViewMode: () => "age",
      getTheme: () => this.theme,
      getTiming: (tokenId) => this.pressure.timing(tokenId),
    });
    this.tooltip = new AgeStripTooltip({
      canvas,
      getViewMode: () => "age",
      getBook: (tokenId) =>
        this.bookCache.get(tokenId) ?? this.feed?.getBook(tokenId),
      getTokenName: (tokenId) => this.tokenNameByToken.get(tokenId),
      getOppositeTokenName: (tokenId) =>
        this.oppositeTokenNameByToken.get(tokenId),
      getPressureColorScale: (tokenId) =>
        this.scaleByToken.get(tokenId) ?? DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    });

    this.unsubscribeTuning = subscribeAgeStripTuning(() => {
      this.requestDraw();
    });

    const height =
      TOP_PADDING_PX +
      BOTTOM_PADDING_PX +
      SERIES_VISIBLE_ROWS * SERIES_ROW_HEIGHT_PX;
    this.canvasWrap.style.height = `${height}px`;

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.requestDraw();
    });
    this.resizeObserver.observe(canvas);

    this.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  async start(): Promise<void> {
    await this.ensureWindow(Date.now(), true);
    if (this.destroyed) return;

    this.scheduleClockFrame();
    this.requestDraw();
  }

  jumpTo(timeMs: number): void {
    if (!Number.isFinite(timeMs)) return;
    this.userOffsetMs = timeMs - Date.now();
    this.setFollowing(false);
    void this.ensureWindow(timeMs, true);
    this.requestDraw();
  }

  followLive(): void {
    this.userOffsetMs = 0;
    this.setFollowing(true);
    void this.ensureWindow(Date.now(), true);
    this.requestDraw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feedGeneration++;
    this.feed?.destroy();
    this.feed = null;
    this.unsubscribeTuning();
    this.ageClock.destroy();
    this.tooltip.destroy();
    if (this.clockTimer !== undefined) window.clearTimeout(this.clockTimer);
    if (this.ghostRefreshTimer !== undefined)
      window.clearTimeout(this.ghostRefreshTimer);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.plotter.destroy();
    this.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private readonly handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = chartThemeForDarkMode(event.matches);
    this.ageClock.refresh();
    this.requestDraw();
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (handleAgeStripTuningWheel(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
      delta *= Math.max(1, this.plotter.height);

    this.panByCssPixels(-delta);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private panByCssPixels(deltaPx: number): void {
    if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
    this.userOffsetMs += (deltaPx / SERIES_ROW_HEIGHT_PX) * this.cadenceMs;
    this.setFollowing(false);
    const center = Date.now() + this.userOffsetMs;
    void this.ensureWindow(center);
    this.requestDraw();
  }

  private setFollowing(value: boolean): void {
    if (this.following === value) return;
    this.following = value;
    this.onFollowingChanged(value);
  }

  private async ensureWindow(centerMs: number, force = false): Promise<void> {
    if (this.destroyed) return;

    const reloadDistance =
      SERIES_WINDOW_ROWS * this.cadenceMs * WINDOW_RELOAD_FRACTION;
    if (
      !force &&
      this.loadedCenterMs !== null &&
      Math.abs(centerMs - this.loadedCenterMs) < reloadDistance
    )
      return;
    if (
      !force &&
      this.loadingCenterMs !== null &&
      Math.abs(centerMs - this.loadingCenterMs) < reloadDistance
    )
      return;

    const generation = ++this.loadGeneration;
    this.loadingCenterMs = centerMs;

    try {
      const loaded = await loadSeriesEventsAround(
        this.client,
        this.series,
        centerMs,
        this.cadenceMs,
      );
      if (this.destroyed || generation !== this.loadGeneration) return;

      const compatible = loaded.filter((event) =>
        event.markets.some((market) => market.outcomes.yes.tokenId),
      );
      if (compatible.length === 0)
        throw new Error(
          "No timed binary events were found in this series window",
        );

      this.cadenceMs = inferSeriesCadenceMs(compatible, this.series.recurrence);
      this.rows = compatible
        .map((event) => timedSeriesEvent(event, this.cadenceMs))
        .filter((row): row is TimedSeriesEvent => row !== null);
      this.absoluteTimeLabelByStart.clear();
      for (const row of this.rows)
        this.absoluteTimeLabelByStart.set(
          row.startMs,
          this.absoluteTimeLabelByStart.get(row.startMs) ??
            formatTimelineTime(row.startMs, this.cadenceMs),
        );

      const keepTokens = new Set<string>();
      this.scaleByToken.clear();
      this.tokenNameByToken.clear();
      this.oppositeTokenNameByToken.clear();
      for (const row of this.rows) {
        for (const [marketIndex, market] of row.event.markets.entries()) {
          const tokenId = market.outcomes.yes.tokenId;
          if (!tokenId) continue;
          const key = String(tokenId);
          keepTokens.add(key);
          this.scaleByToken.set(
            key,
            defaultPressureScaleForMarket(row.event, marketIndex),
          );
          this.tokenNameByToken.set(key, market.outcomes.yes.label);
          if (market.outcomes.no.label)
            this.oppositeTokenNameByToken.set(key, market.outcomes.no.label);
          this.pressure.ensure(key, row.endMs);
        }
      }

      for (const tokenId of this.bookCache.keys())
        if (!keepTokens.has(tokenId)) this.bookCache.delete(tokenId);
      this.pressure.retain(keepTokens);
      for (const tokenId of [...this.hydratedTokens])
        if (!keepTokens.has(tokenId)) this.hydratedTokens.delete(tokenId);

      this.loadedCenterMs = centerMs;
      this.loadedMinStartMs =
        this.rows.length > 0 ? this.rows[0]!.startMs : null;
      this.loadedMaxStartMs =
        this.rows.length > 0 ? this.rows.at(-1)!.startMs : null;
      this.loadingCenterMs = null;
      this.lastEdgeRefreshMs = Date.now();
      this.onWindowChanged(compatible.length);
      this.updateAnchorEvent(Date.now());
      this.scheduleClockFrame();
      this.requestDraw();
    } catch (error) {
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.loadingCenterMs = null;
      this.onError(error instanceof Error ? error.message : String(error));
      if (this.rows.length === 0) throw error;
    }
  }

  private requestDraw(): void {
    if (this.destroyed || this.raf !== null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  private draw(): void {
    if (this.destroyed) return;
    if (this.ghostRefreshTimer !== undefined) {
      window.clearTimeout(this.ghostRefreshTimer);
      this.ghostRefreshTimer = undefined;
    }

    const nowMs = Date.now();
    const centerMs = nowMs + this.userOffsetMs;
    const spanMs = SERIES_VISIBLE_ROWS * this.cadenceMs;
    const minMs = centerMs - spanMs / 2;
    const maxMs = centerMs + spanMs / 2;

    const frame = this.plotter.beginFrame(this.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: minMs, max: maxMs },
    });

    const subscriptionPaddingMs = SUBSCRIPTION_BUFFER_ROWS * this.cadenceMs;
    const bufferedRows = this.rows.filter(
      (row) =>
        row.centerMs >= minMs - subscriptionPaddingMs &&
        row.centerMs <= maxMs + subscriptionPaddingMs,
    );
    const visibleRows = bufferedRows.filter(
      (row) =>
        row.centerMs >= minMs - this.cadenceMs &&
        row.centerMs <= maxMs + this.cadenceMs,
    );

    const bufferedTokens: TokenId[] = [];
    const hydratableTokens: string[] = [];
    for (const row of bufferedRows) {
      const market = primaryMarket(row.event);
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      const lifecycle = this.marketLifecycle(market);
      if (lifecycle.kind !== "resolved") hydratableTokens.push(String(tokenId));
      if (lifecycle.kind === "live") bufferedTokens.push(tokenId);
    }
    void this.hydrateTokens(hydratableTokens);

    const tuning = getAgeStripTuning();
    let hasVisibleGhosts = false;

    for (const row of visibleRows) {
      const market = primaryMarket(row.event);
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      const key = String(tokenId);
      const scale = this.pressureScale(row.event, market);
      const lifecycle = this.marketLifecycle(market);
      const rowOffsetCss = seriesRowOffsetCss(frame, row.centerMs);

      if (lifecycle.kind === "resolved") {
        const primaryWon = String(lifecycle.winningTokenId) === key;
        drawResolvedMarketStrip(
          frame,
          row.centerMs,
          primaryWon ? "primary" : "opposite",
          lifecycle.winningOutcome,
          scale,
          rowOffsetCss,
        );
        continue;
      }

      drawPressureMemoryStrip(
        frame,
        row.centerMs,
        this.pressure.cells(key),
        scale,
        tuning.volumePerCssPixel,
        tuning.ghostHalfLifeMs,
        nowMs,
        rowOffsetCss,
      );
      hasVisibleGhosts ||= this.pressure.hasVisibleGhosts(
        key,
        nowMs,
        tuning.ghostHalfLifeMs,
      );
    }

    this.drawTimeline(frame, visibleRows, nowMs);
    this.updateAgeOverlays(frame, visibleRows);
    this.updateAnchorEvent(nowMs);
    this.refreshFeed(bufferedTokens);
    this.refreshWindowIfNeeded(centerMs, minMs, maxMs, nowMs);

    if (hasVisibleGhosts)
      this.scheduleGhostRefresh(ghostRefreshDelayMs(tuning.ghostHalfLifeMs));
  }

  private drawTimeline(
    frame: Frame,
    rows: readonly TimedSeriesEvent[],
    nowMs: number,
  ): void {
    const { ctx, viewport: vp, theme } = frame;
    const dpr = window.devicePixelRatio || 1;
    const timelineX = vp.l + vp.width + TIMELINE_RELATIVE_GUTTER_PX;

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(timelineX, 0);
    ctx.lineTo(timelineX, this.plotter.height);
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";

    // Event boundaries are the absolute clock: these drift past the independent
    // relative-time ticks as wall time advances.
    for (const row of rows) {
      const market = primaryMarket(row.event);
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      const geometry = seriesRowGeometry(frame, row.centerMs, dpr);
      if (
        geometry.topCss > vp.t + vp.height ||
        geometry.topCss + geometry.heightCss < vp.t
      )
        continue;

      const scale = this.pressureScale(row.event, market);
      drawAgeRowRails(frame, geometry, scale);

      const startY = frame.toScreenY(0, row.startMs);
      if (startY >= vp.t - 1 && startY <= vp.t + vp.height + 1) {
        ctx.strokeStyle = theme.axis;
        ctx.beginPath();
        ctx.moveTo(timelineX, startY);
        ctx.lineTo(timelineX + 3, startY);
        ctx.stroke();

        ctx.fillStyle = theme.text;
        ctx.textAlign = "left";
        ctx.fillText(
          formatTimelineTime(row.startMs, this.cadenceMs),
          timelineX + 6,
          startY,
        );
      }
    }

    // Relative ticks are anchored to "now", not to event boundaries.
    const minK = Math.ceil((frame.domain.yRange.min - nowMs) / this.cadenceMs);
    const maxK = Math.floor((frame.domain.yRange.max - nowMs) / this.cadenceMs);
    for (let k = minK; k <= maxK; k++) {
      const tickTime = nowMs + k * this.cadenceMs;
      const tickY = frame.toScreenY(0, tickTime);
      if (tickY < vp.t - 1 || tickY > vp.t + vp.height + 1) continue;

      ctx.strokeStyle = theme.axis;
      ctx.beginPath();
      ctx.moveTo(timelineX - 3, tickY);
      ctx.lineTo(timelineX, tickY);
      ctx.stroke();

      ctx.fillStyle = theme.text;
      ctx.textAlign = "right";
      ctx.fillText(
        relativeCadenceLabel(k, this.cadenceMs),
        timelineX - 6,
        tickY,
      );
    }

    const nowY = frame.toScreenY(0, nowMs);
    if (nowY >= vp.t && nowY <= vp.t + vp.height) {
      ctx.save();
      ctx.fillStyle = this.theme.bg;
      ctx.beginPath();
      ctx.arc(timelineX, nowY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.theme.text;
      ctx.beginPath();
      ctx.arc(timelineX, nowY, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private updateAgeOverlays(
    frame: Frame,
    rows: readonly TimedSeriesEvent[],
  ): void {
    const vp = frame.viewport;
    const dpr = window.devicePixelRatio || 1;
    const geometry: AgeStripGeometry = {
      viewport: {
        l: vp.l,
        t: vp.t,
        width: vp.width,
        height: vp.height,
      },
      rows: rows.flatMap((row) => {
        const market = primaryMarket(row.event);
        const tokenId = market?.outcomes.yes.tokenId;
        if (!tokenId) return [];

        const raster = seriesRowGeometry(frame, row.centerMs, dpr);
        const lifecycle = this.marketLifecycle(market);
        const resolution =
          lifecycle.kind === "resolved"
            ? {
                side:
                  String(lifecycle.winningTokenId) === String(tokenId)
                    ? ("primary" as const)
                    : ("opposite" as const),
                outcome: lifecycle.winningOutcome,
                marketEndMs: row.endMs,
              }
            : undefined;

        return [
          {
            tokenId: String(tokenId),
            centerY: raster.centerCss,
            topY: raster.topCss,
            bottomY: raster.topCss + raster.heightCss,
            resolution,
          },
        ];
      }),
      canvasWidth: vp.l + vp.width + this.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.plotter.padding.b,
    };
    this.ageClock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);
  }

  private pressureScale(event: Event, market: Market): SignedVolumeColorScale {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) {
      const cached = this.scaleByToken.get(String(tokenId));
      if (cached) return cached;
    }

    const index = Math.max(0, event.markets.indexOf(market));
    return defaultPressureScaleForMarket(event, index);
  }

  private marketLifecycle(market: Market): MarketLifecycle {
    const initial = initialMarketLifecycle(market);
    const conditionId = market.conditionId ? String(market.conditionId) : null;
    const primary = market.outcomes.yes.tokenId;
    const opposite = market.outcomes.no.tokenId;
    if (!primary) return initial;

    const update =
      (conditionId ? this.resolutionByCondition.get(conditionId) : undefined) ??
      this.resolutionByAsset.get(String(primary)) ??
      (opposite ? this.resolutionByAsset.get(String(opposite)) : undefined);
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

  private refreshFeed(tokenIds: readonly TokenId[]): void {
    const unique = [...new Set(tokenIds.map(String))]
      .sort()
      .map((tokenId) => tokenId as TokenId);
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
        const key = String(tokenId);
        this.bookCache.set(key, book);
        this.pressure.applyBookUpdate(key, book, update);
        this.requestDraw();
      },
      onMarketResolved: (resolution) => {
        if (this.destroyed || generation !== this.feedGeneration) return;
        this.resolutionByCondition.set(resolution.conditionId, resolution);
        for (const assetId of resolution.assetIds) {
          this.resolutionByAsset.set(assetId, resolution);
          this.bookCache.delete(assetId);
          this.pressure.resolve(assetId);
        }
        this.requestDraw();
      },
    });
    this.feed = feed;

    void feed.start(unique).catch((error) => {
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
    const hydration = await fetchRecorderHydration(fresh);
    if (this.destroyed) return;

    this.pressure.setRecordingCoverage(hydration.recordingSinceMsByToken);
    this.pressure.hydrate(
      hydration.pressureCellsByToken,
      (tokenId) => this.bookCache.get(tokenId) ?? this.feed?.getBook(tokenId),
    );
    this.ageClock.refresh();
    this.requestDraw();
  }

  private updateAnchorEvent(nowMs: number): void {
    if (this.rows.length === 0) {
      if (this.lastAnchorEventId !== null) {
        this.lastAnchorEventId = null;
        this.onAnchorEventChanged(null);
      }
      return;
    }

    const anchor =
      this.rows.find((row) => row.startMs <= nowMs && nowMs < row.endMs) ??
      this.rows.reduce((best, row) =>
        Math.abs(row.centerMs - nowMs) < Math.abs(best.centerMs - nowMs)
          ? row
          : best,
      );

    const id = String(anchor.event.id);
    if (id === this.lastAnchorEventId) return;
    this.lastAnchorEventId = id;
    this.onAnchorEventChanged(anchor.event);
  }

  private refreshWindowIfNeeded(
    centerMs: number,
    minMs: number,
    maxMs: number,
    nowMs: number,
  ): void {
    const edgePaddingMs = Math.max(SERIES_VISIBLE_ROWS, 3) * this.cadenceMs;
    const nearPastEdge =
      this.loadedMinStartMs === null ||
      minMs <= this.loadedMinStartMs + edgePaddingMs;
    const nearFutureEdge =
      this.loadedMaxStartMs === null ||
      maxMs >= this.loadedMaxStartMs - edgePaddingMs;

    if (!nearPastEdge && !nearFutureEdge) {
      void this.ensureWindow(centerMs);
      return;
    }

    const refreshEveryMs = Math.max(
      5_000,
      Math.min(60_000, this.cadenceMs / 2),
    );
    if (nowMs - this.lastEdgeRefreshMs < refreshEveryMs) return;
    this.lastEdgeRefreshMs = nowMs;
    void this.ensureWindow(centerMs, true);
  }

  private scheduleClockFrame(): void {
    if (this.destroyed) return;
    if (this.clockTimer !== undefined) window.clearTimeout(this.clockTimer);

    const nowMs = Date.now();
    const dpr = window.devicePixelRatio || 1;
    const stepCssPx = 0.25 / dpr;
    const pixelsPerMs = SERIES_ROW_HEIGHT_PX / this.cadenceMs;
    const currentPx = nowMs * pixelsPerMs;
    const nextPx = (Math.floor(currentPx / stepCssPx) + 1) * stepCssPx;
    const nextMs = nextPx / pixelsPerMs;
    const delayMs = Math.max(16, nextMs - nowMs);

    this.clockTimer = window.setTimeout(() => {
      this.clockTimer = undefined;
      this.requestDraw();
      this.scheduleClockFrame();
    }, delayMs);
  }

  private scheduleGhostRefresh(delayMs: number): void {
    if (this.destroyed || this.ghostRefreshTimer !== undefined) return;

    this.ghostRefreshTimer = window.setTimeout(() => {
      this.ghostRefreshTimer = undefined;
      this.requestDraw();
    }, delayMs);
  }
}

function primaryMarket(event: Event): Market | null {
  return event.markets.find((market) => market.outcomes.yes.tokenId) ?? null;
}

function formatTimelineTime(timestampMs: number, cadenceMs: number): string {
  const date = new Date(timestampMs);
  if (cadenceMs >= 24 * 60 * 60_000)
    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    });
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function relativeCadenceLabel(offset: number, cadenceMs: number): string {
  if (offset === 0) return "now";

  const magnitudeMs = Math.abs(offset) * cadenceMs;
  const sign = offset < 0 ? "−" : "";

  if (magnitudeMs < 60_000) return `${sign}${Math.round(magnitudeMs / 1_000)}s`;
  if (magnitudeMs < 60 * 60_000)
    return `${sign}${formatCompactDuration(magnitudeMs / 60_000)}m`;
  if (magnitudeMs < 48 * 60 * 60_000)
    return `${sign}${formatCompactDuration(magnitudeMs / (60 * 60_000))}h`;
  return `${sign}${formatCompactDuration(magnitudeMs / (24 * 60 * 60_000))}d`;
}

function formatCompactDuration(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function seriesRowOffsetCss(frame: Frame, y: number): number {
  const dpr = window.devicePixelRatio || 1;
  const desiredCenter = frame.toScreenY(0, y);
  const snapped = rowRasterGeometry(desiredCenter, dpr);
  return desiredCenter - snapped.centerCss;
}

function seriesRowGeometry(frame: Frame, y: number, dpr: number) {
  const desiredCenter = frame.toScreenY(0, y);
  const geometry = rowRasterGeometry(desiredCenter, dpr);
  const offsetCss = desiredCenter - geometry.centerCss;
  return {
    ...geometry,
    topCss: geometry.topCss + offsetCss,
    centerCss: desiredCenter,
  };
}
