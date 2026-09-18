import { fetchRecorderCoverage } from "@/lib/ageRecorderClient";
import type { ConnectionStatus, ViewMode } from "@/lib/chartState";
import {
  pressureScaleForToken,
  type ChartDefinition,
} from "@/lib/chartDefinition";
import { marketColor } from "@/lib/math";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import {
  BookOrder,
  emptyTokenBook,
} from "@/lib/orderBook";
import {
  BoxStyle,
  ChartTheme,
  Frame,
  OrderBookPlotter,
  StackDirection,
} from "@/lib/renderer";
import { AgeStripView } from "./ageStripView";
import { LiveBookFeed } from "./liveBookFeed";
import {
  TokenId,
  PublicClient,
} from "@polymarket/client";

interface BookBoxView {
  readonly direction: StackDirection;
  readonly orders: Iterable<BookOrder>;
  readonly color: string;
  readonly fillDepth?: number;
}

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

export interface ChartSurfaceElements {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly hiddenTray: HTMLDivElement;
}

export type AutoHiddenReason = "empty-book" | "resolved";

export interface ChartControllerOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onMarketAutoHidden?: (
    marketId: string,
    reason: AutoHiddenReason,
  ) => void;
}

export class ChartController {
  private readonly feed: LiveBookFeed;
  private readonly onMarketAutoHidden: (
    marketId: string,
    reason: AutoHiddenReason,
  ) => void;
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly activeTokens = new Set<TokenId>();

  private theme: ChartTheme;
  private plotter!: OrderBookPlotter;
  private ageView!: AgeStripView;
  private raf: number | null = null;
  private pointer: { sx: number; sy: number } | null = null;
  private readonly definition: ChartDefinition;
  private volScale = 4.5;
  private viewMode: ViewMode = "age";
  private started = false;
  private destroyed = false;

  constructor(
    surface: ChartSurfaceElements,
    polyMarketClient: PublicClient,
    definition: ChartDefinition,
    options: ChartControllerOptions = {},
  ) {
    this.definition = definition;
    this.onMarketAutoHidden =
      options.onMarketAutoHidden ?? (() => undefined);

    this.feed = new LiveBookFeed(polyMarketClient, {
      onConnectionStatus:
        options.onConnectionStatus ?? (() => undefined),
      onBookUpdated: (tokenId) => {
        this.ageView.onBookUpdate(tokenId);
        this.reqDraw();
      },
      onMarketResolved: (tokenIds) => {
        for (const tokenId of tokenIds)
          this.autoHideToken(tokenId, "resolved");
      },
    });

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = this.themeQuery.matches ? DARK_THEME : LIGHT_THEME;

    this.plotter = new OrderBookPlotter(surface.canvas);
    this.plotter.onZoom = (delta) => {
      if (this.viewMode !== "volume") return;
      this.volScale += delta;
      this.reqDraw();
    };
    this.plotter.onPointer = (pointer) => {
      this.pointer = pointer;
      if (this.viewMode === "volume") this.reqDraw();
    };

    this.ageView = new AgeStripView({
      canvas: surface.canvas,
      canvasWrap: surface.canvasWrap,
      toggles: surface.toggles,
      hiddenTray: surface.hiddenTray,
      plotter: this.plotter,
      activeTokens: this.activeTokens,
      getBook: (tokenId) => this.feed.getBook(tokenId),
      getTokenName: (tokenId) =>
        this.definition.tokenNames.get(String(tokenId)),
      getOppositeTokenName: (tokenId) =>
        this.definition.oppositeTokenNames.get(String(tokenId)),
      getPressureColorScale: (tokenId) =>
        this.pressureColorScale(tokenId as TokenId),
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      hideToken: (tokenId) =>
        this.autoHideToken(tokenId as TokenId, "empty-book"),
      requestDraw: () => this.reqDraw(),
    });

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.reqDraw();
    });
    this.resizeObserver.observe(surface.canvas);
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  private handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = event.matches ? DARK_THEME : LIGHT_THEME;
    this.reqDraw();
  };

  async start(
    hiddenMarketIds: ReadonlySet<string>,
  ): Promise<void> {
    if (this.started) throw new Error("ChartController already started");
    if (this.destroyed) throw new Error("ChartController is destroyed");
    this.started = true;

    const { event } = this.definition;
    const tokenIds = this.definition.controls.map(
      (control) => control.tokenId,
    );

    for (const control of this.definition.controls)
      if (!hiddenMarketIds.has(control.marketId))
        this.activeTokens.add(control.tokenId);

    this.ageView.configureMarkets(this.definition.controls);

    // Recorder registration/metadata is optional and must never gate the live
    // websocket.
    void fetchRecorderCoverage(tokenIds).then((hydration) => {
      if (this.destroyed) return;
      this.ageView.setRecordingCoverage(
        hydration.recordingSinceMsByToken,
      );
      this.reqDraw();
    });

    await this.feed.start(tokenIds);
    if (!this.destroyed) this.reqDraw();
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.reqDraw();
  }

  setMarketVisible(marketId: string, visible: boolean): void {
    const control = this.definition.controls.find(
      (candidate) => candidate.marketId === marketId,
    );
    if (!control) return;

    if (visible) this.activeTokens.add(control.tokenId);
    else this.activeTokens.delete(control.tokenId);
    this.reqDraw();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feed.destroy();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ageView.destroy();
    this.plotter.destroy();
    this.resizeObserver.disconnect();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private pressureColorScale(tokenId: TokenId): SignedVolumeColorScale {
    return pressureScaleForToken(this.definition, String(tokenId));
  }

  private autoHideToken(
    tokenId: TokenId,
    reason: AutoHiddenReason,
  ): void {
    if (!this.activeTokens.delete(tokenId)) return;
    const control = this.definition.controls.find(
      (candidate) => candidate.tokenId === tokenId,
    );
    if (control) this.onMarketAutoHidden(control.marketId, reason);
    this.reqDraw();
  }

  private reqDraw() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw() {
    this.raf = null;
    if (this.viewMode === "age") this.ageView.draw();
    else this.drawVolumeView();
  }

  private drawVolumeView() {
    this.ageView.prepareVolumeView();

    const yAbsMax = Math.pow(10, this.volScale);
    const frame = this.plotter.beginFrame(this.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: -yAbsMax, max: yAbsMax },
    });
    frame.drawAxes();

    const pointerData = this.pointer ? frame.toData(this.pointer) : null;
    const empty = emptyTokenBook();
    const placeholderColor = marketColor("", 0);

    this.drawBookView(frame, {
      direction: "up",
      orders: empty.usdToYes.asOrders(),
      color: placeholderColor,
    });
    this.drawBookView(frame, {
      direction: "down",
      orders: empty.yesToUsd.asSellOrders(),
      color: placeholderColor,
    });

    for (const [index, market] of this.definition.event.markets.entries()) {
      const tokenId = market.outcomes.yes.tokenId;
      if (!tokenId || !this.activeTokens.has(tokenId)) continue;

      const book = this.feed.getBook(tokenId) ?? emptyTokenBook();
      const semanticScale =
        this.definition.pressureScales.get(String(tokenId));
      const yesColor = semanticScale
        ? signedVolumeColor(1, semanticScale)
        : marketColor(this.definition.event.id, index);
      const noColor = semanticScale
        ? signedVolumeColor(-1, semanticScale)
        : yesColor;

      this.drawBookView(frame, {
        direction: "up",
        orders: book.usdToYes.asOrders(),
        color: yesColor,
        fillDepth: pointerData ? Math.max(pointerData.y, 0) : undefined,
      });
      this.drawBookView(frame, {
        direction: "down",
        orders: book.yesToUsd.asSellOrders(),
        color: noColor,
        fillDepth: pointerData ? Math.max(-pointerData.y, 0) : undefined,
      });
    }

    if (this.pointer && pointerData) frame.drawPointer(pointerData, this.pointer);
  }

  private drawBookView(frame: Frame, view: BookBoxView) {
    const emptyStyle = ChartController.boxStyle(view.color, false);
    const filledStyle = ChartController.boxStyle(view.color, true);
    const pen = frame.boxPen(
      { direction: view.direction, anchor: "left" },
      emptyStyle,
    );

    let remainingHeight = frame.domain.yRange.max;
    let fillRemaining = Math.min(view.fillDepth ?? 0, remainingHeight);

    for (const level of view.orders) {
      const rowHeight = Math.min(level.take, remainingHeight);
      if (rowHeight <= 0) continue;

      const filledHeight = Math.min(rowHeight, fillRemaining);
      if (filledHeight > 0) {
        ChartController.commitBoxRow(pen, level.price, filledHeight, filledStyle);
        fillRemaining -= filledHeight;
      }

      const emptyHeight = rowHeight - filledHeight;
      if (emptyHeight > 0)
        ChartController.commitBoxRow(pen, level.price, emptyHeight, emptyStyle);

      remainingHeight -= rowHeight;
      if (remainingHeight <= 0) break;
    }
  }

  private static commitBoxRow(
    pen: ReturnType<Frame["boxPen"]>,
    width: number,
    height: number,
    style: BoxStyle,
  ) {
    pen.newBox(style);
    pen.extendBox(width);
    pen.commitRow(height);
  }

  private static boxStyle(color: string, filled: boolean): BoxStyle {
    return {
      stroke: color,
      fill: filled ? { kind: "solid-dim", alpha: 0.25 } : { kind: "none" },
    };
  }


}
