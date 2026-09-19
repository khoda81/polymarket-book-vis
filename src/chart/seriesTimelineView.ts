import {
  drawLivePressureStrip,
  drawResolvedMarketStrip,
} from "./ageStripRendering";
import {
  rowRasterGeometry,
} from "./ageStripLayout";
import { LiveBookFeed } from "./liveBookFeed";
import {
  SERIES_ROW_HEIGHT_PX,
  SERIES_VISIBLE_ROWS,
  SERIES_WINDOW_ROWS,
  inferSeriesCadenceMs,
  loadSeriesEventsAround,
  timedSeriesEvent,
  type TimedSeriesEvent,
} from "@/lib/seriesTimeline";
import { getAgeStripTuning } from "@/lib/ageStripTuning";
import {
  initialMarketLifecycle,
  resolveMarketLifecycle,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/lib/marketLifecycle";
import { stableHue } from "@/lib/negRiskColors";
import {
  OrderBookPlotter,
  type ChartTheme,
  type Frame,
} from "@/lib/renderer";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import { semanticYesNeutralNoScale } from "@/lib/thresholdColors";
import type {
  ConnectionStatus,
} from "@/lib/chartState";
import type {
  Event,
  Market,
  PublicClient,
  Series,
  TokenId,
} from "@polymarket/client";

const LIGHT_THEME: ChartTheme = {
  bg: "#ffffff",
  grid: "rgba(128,128,128,0.15)",
  axis: "rgba(128,128,128,0.5)",
  text: "#666666",
};

const DARK_THEME: ChartTheme = {
  bg: "#121212",
  grid: "rgba(255,255,255,0.1)",
  axis: "rgba(255,255,255,0.3)",
  text: "#aaaaaa",
};

const LEFT_PADDING_PX = 72;
const RIGHT_PADDING_PX = 78;
const TOP_PADDING_PX = 8;
const BOTTOM_PADDING_PX = 24;
const WINDOW_RELOAD_FRACTION = 0.45;

export interface SeriesTimelineViewOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onFollowingChanged?: (following: boolean) => void;
  readonly onWindowChanged?: (eventCount: number) => void;
  readonly onError?: (message: string) => void;
}

export class SeriesTimelineView {
  private readonly plotter: OrderBookPlotter;
  private readonly resizeObserver: ResizeObserver;
  private readonly themeQuery: MediaQueryList;
  private readonly scale: SignedVolumeColorScale;
  private readonly onConnectionStatus: (status: ConnectionStatus) => void;
  private readonly onFollowingChanged: (following: boolean) => void;
  private readonly onWindowChanged: (eventCount: number) => void;
  private readonly onError: (message: string) => void;
  private readonly resolutionByCondition = new Map<
    string,
    MarketResolutionUpdate
  >();
  private readonly resolutionByAsset = new Map<
    string,
    MarketResolutionUpdate
  >();

  private theme: ChartTheme;
  private events: Event[];
  private cadenceMs: number;
  private userOffsetMs = 0;
  private following = true;
  private feed: LiveBookFeed | null = null;
  private feedGeneration = 0;
  private feedKey = "";
  private loadGeneration = 0;
  private loadedCenterMs: number | null = null;
  private loadingCenterMs: number | null = null;
  private clockTimer: number | undefined;
  private raf: number | null = null;
  private destroyed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly canvasWrap: HTMLElement,
    private readonly client: PublicClient,
    private readonly series: Series,
    options: SeriesTimelineViewOptions = {},
  ) {
    this.events = [...(series.events ?? [])];
    this.cadenceMs = inferSeriesCadenceMs(
      this.events,
      series.recurrence,
    );
    this.scale = semanticYesNeutralNoScale(
      stableHue(`series:${String(series.id)}`),
    );
    this.onConnectionStatus =
      options.onConnectionStatus ?? (() => undefined);
    this.onFollowingChanged =
      options.onFollowingChanged ?? (() => undefined);
    this.onWindowChanged =
      options.onWindowChanged ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = this.themeQuery.matches ? DARK_THEME : LIGHT_THEME;

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
    if (this.clockTimer !== undefined)
      window.clearTimeout(this.clockTimer);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.plotter.destroy();
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private readonly handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = event.matches ? DARK_THEME : LIGHT_THEME;
    this.requestDraw();
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;

    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
      delta *= Math.max(1, this.plotter.height);

    this.panByCssPixels(-delta);
    event.preventDefault();
    event.stopPropagation();
  };

  private panByCssPixels(deltaPx: number): void {
    if (!Number.isFinite(deltaPx) || deltaPx === 0) return;
    this.userOffsetMs +=
      (deltaPx / SERIES_ROW_HEIGHT_PX) * this.cadenceMs;
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

  private async ensureWindow(
    centerMs: number,
    force = false,
  ): Promise<void> {
    if (this.destroyed) return;

    const reloadDistance =
      SERIES_WINDOW_ROWS *
      this.cadenceMs *
      WINDOW_RELOAD_FRACTION;
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
        throw new Error("No timed binary events were found in this series window");

      this.events = compatible;
      this.cadenceMs = inferSeriesCadenceMs(
        compatible,
        this.series.recurrence,
      );
      this.loadedCenterMs = centerMs;
      this.loadingCenterMs = null;
      this.onWindowChanged(compatible.length);
      this.scheduleClockFrame();
      this.requestDraw();
    } catch (error) {
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.loadingCenterMs = null;
      this.onError(
        error instanceof Error ? error.message : String(error),
      );
      // Initial load with no seed data is fatal. Background window refreshes
      // keep the last usable cache instead of creating unhandled rejections.
      if (this.events.length === 0) throw error;
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

    const nowMs = Date.now();
    const centerMs = nowMs + this.userOffsetMs;
    const spanMs = SERIES_VISIBLE_ROWS * this.cadenceMs;
    const minMs = centerMs - spanMs / 2;
    const maxMs = centerMs + spanMs / 2;

    const frame = this.plotter.beginFrame(this.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: minMs, max: maxMs },
    });

    const rows = this.events
      .map((event) => timedSeriesEvent(event, this.cadenceMs))
      .filter((row): row is TimedSeriesEvent => row !== null)
      .filter(
        (row) =>
          row.centerMs >= minMs - this.cadenceMs &&
          row.centerMs <= maxMs + this.cadenceMs,
      );

    const activeTokens: TokenId[] = [];
    const volumePerCssPixel = getAgeStripTuning().volumePerCssPixel;

    for (const row of rows) {
      const market = primaryMarket(row.event);
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      const lifecycle = this.marketLifecycle(market);
      if (lifecycle.kind === "resolved") {
        const primaryWon =
          String(lifecycle.winningTokenId) === String(tokenId);
        drawResolvedMarketStrip(
          frame,
          row.centerMs,
          primaryWon ? "primary" : "opposite",
          lifecycle.winningOutcome,
          this.scale,
        );
      } else {
        const book = this.feed?.getBook(String(tokenId));
        if (book)
          drawLivePressureStrip(
            frame,
            row.centerMs,
            book,
            this.scale,
            volumePerCssPixel,
          );

        if (
          lifecycle.kind === "live" &&
          row.centerMs >= minMs - this.cadenceMs &&
          row.centerMs <= maxMs + this.cadenceMs
        )
          activeTokens.push(tokenId);
      }
    }

    this.drawTimeline(frame, rows, nowMs);
    this.refreshFeed(activeTokens);
    void this.ensureWindow(centerMs);
  }

  private drawTimeline(
    frame: Frame,
    rows: readonly TimedSeriesEvent[],
    nowMs: number,
  ): void {
    const { ctx, viewport: vp, theme } = frame;
    const dpr = window.devicePixelRatio || 1;
    const timelineX = vp.l - 15;

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(timelineX, vp.t);
    ctx.lineTo(timelineX, vp.t + vp.height);
    ctx.stroke();

    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";

    for (const row of rows) {
      const market = primaryMarket(row.event);
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      const geometry = rowRasterGeometry(
        frame.toScreenY(0, row.centerMs),
        dpr,
      );
      if (
        geometry.topCss > vp.t + vp.height ||
        geometry.topCss + geometry.heightCss < vp.t
      )
        continue;

      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(vp.l, geometry.topCss);
      ctx.lineTo(vp.l + vp.width, geometry.topCss);
      ctx.stroke();

      ctx.strokeStyle = signedVolumeColor(-1, this.scale);
      ctx.beginPath();
      ctx.moveTo(vp.l, geometry.topCss);
      ctx.lineTo(vp.l, geometry.topCss + geometry.heightCss);
      ctx.stroke();

      ctx.strokeStyle = signedVolumeColor(1, this.scale);
      ctx.beginPath();
      ctx.moveTo(vp.l + vp.width, geometry.topCss);
      ctx.lineTo(
        vp.l + vp.width,
        geometry.topCss + geometry.heightCss,
      );
      ctx.stroke();

      const startY = frame.toScreenY(0, row.startMs);
      if (startY >= vp.t - 1 && startY <= vp.t + vp.height + 1) {
        ctx.strokeStyle = theme.axis;
        ctx.beginPath();
        ctx.moveTo(timelineX - 3, startY);
        ctx.lineTo(timelineX + 3, startY);
        ctx.stroke();

        ctx.fillStyle = theme.text;
        ctx.textAlign = "right";
        ctx.fillText(
          formatTimelineTime(row.startMs, this.cadenceMs),
          timelineX - 6,
          startY,
        );
      }

      const lifecycle = this.marketLifecycle(market);
      ctx.textAlign = "left";
      ctx.fillStyle =
        lifecycle.kind === "resolved"
          ? signedVolumeColor(
              String(lifecycle.winningTokenId) === String(tokenId)
                ? 1
                : -1,
              this.scale,
            )
          : theme.text;
      ctx.fillText(
        rowStatus(row, lifecycle, nowMs),
        vp.l + vp.width + 8,
        geometry.centerCss,
      );
    }

    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0", vp.l, vp.t + vp.height + 8);
    ctx.fillText("1", vp.l + vp.width, vp.t + vp.height + 8);

    const nowY = frame.toScreenY(0, nowMs);
    if (nowY >= vp.t && nowY <= vp.t + vp.height) {
      ctx.save();
      ctx.strokeStyle = this.theme.text;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = Math.max(1 / dpr, 1);
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(timelineX, nowY);
      ctx.lineTo(vp.l + vp.width, nowY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 1;
      ctx.fillStyle = this.theme.bg;
      ctx.beginPath();
      ctx.arc(timelineX, nowY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = this.theme.text;
      ctx.beginPath();
      ctx.arc(timelineX, nowY, 3, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = this.theme.text;
      ctx.font = "600 9px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("NOW", timelineX + 6, nowY - 2);
      ctx.restore();
    }
  }

  private marketLifecycle(market: Market): MarketLifecycle {
    const initial = initialMarketLifecycle(market);
    const conditionId = market.conditionId
      ? String(market.conditionId)
      : null;
    const primary = market.outcomes.yes.tokenId;
    const opposite = market.outcomes.no.tokenId;
    if (!primary) return initial;

    const update =
      (conditionId
        ? this.resolutionByCondition.get(conditionId)
        : undefined) ??
      this.resolutionByAsset.get(String(primary)) ??
      (opposite
        ? this.resolutionByAsset.get(String(opposite))
        : undefined);
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

    if (unique.length === 0) {
      this.onConnectionStatus("disconnected");
      return;
    }

    const feed = new LiveBookFeed(this.client, {
      onConnectionStatus: (status) => {
        if (
          !this.destroyed &&
          generation === this.feedGeneration
        )
          this.onConnectionStatus(status);
      },
      onBookUpdated: () => {
        if (
          !this.destroyed &&
          generation === this.feedGeneration
        )
          this.requestDraw();
      },
      onMarketResolved: (resolution) => {
        if (
          this.destroyed ||
          generation !== this.feedGeneration
        )
          return;
        this.resolutionByCondition.set(
          resolution.conditionId,
          resolution,
        );
        for (const assetId of resolution.assetIds)
          this.resolutionByAsset.set(assetId, resolution);
        this.requestDraw();
      },
    });
    this.feed = feed;

    void feed.start(unique).catch((error) => {
      if (
        this.destroyed ||
        generation !== this.feedGeneration
      )
        return;
      this.onConnectionStatus("disconnected");
      this.onError(
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private scheduleClockFrame(): void {
    if (this.destroyed) return;
    if (this.clockTimer !== undefined)
      window.clearTimeout(this.clockTimer);

    const nowMs = Date.now();
    const dpr = window.devicePixelRatio || 1;
    const stepCssPx = 0.25 / dpr;
    const pixelsPerMs = SERIES_ROW_HEIGHT_PX / this.cadenceMs;
    const currentPx = nowMs * pixelsPerMs;
    const nextPx =
      (Math.floor(currentPx / stepCssPx) + 1) * stepCssPx;
    const nextMs = nextPx / pixelsPerMs;
    const delayMs = Math.max(
      16,
      Math.min(60_000, nextMs - nowMs),
    );

    this.clockTimer = window.setTimeout(() => {
      this.clockTimer = undefined;
      this.requestDraw();
      this.scheduleClockFrame();
    }, delayMs);
  }
}

function primaryMarket(event: Event): Market | null {
  return (
    event.markets.find((market) => market.outcomes.yes.tokenId) ??
    null
  );
}

function rowStatus(
  row: TimedSeriesEvent,
  lifecycle: MarketLifecycle,
  nowMs: number,
): string {
  if (lifecycle.kind === "resolved")
    return lifecycle.winningOutcome || "resolved";
  if (lifecycle.kind === "awaiting-resolution")
    return "awaiting";
  if (nowMs < row.startMs) return "future";
  if (nowMs < row.endMs) return "LIVE";
  return "ended";
}

function formatTimelineTime(
  timestampMs: number,
  cadenceMs: number,
): string {
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
