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
  HalfBook,
  TokenBook,
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
import {
  Event,
  OrderSide,
  TokenId,
  TransportError,
  PublicClient,
} from "@polymarket/client";
import { MarketEvent, SubscriptionHandle } from "@polymarket/client/actions";

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
  readonly polyMarketClient: PublicClient;

  private readonly surface: ChartSurfaceElements;
  private readonly onConnectionStatus: (status: ConnectionStatus) => void;
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
  private definition: ChartDefinition | null = null;
  private event: Event | undefined;
  private books: Record<TokenId, TokenBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private volScale = 4.5;
  private viewMode: ViewMode = "age";
  private loadGeneration = 0;
  private destroyed = false;

  constructor(
    surface: ChartSurfaceElements,
    polyMarketClient: PublicClient,
    options: ChartControllerOptions = {},
  ) {
    this.polyMarketClient = polyMarketClient;
    this.surface = surface;
    this.onConnectionStatus =
      options.onConnectionStatus ?? (() => undefined);
    this.onMarketAutoHidden =
      options.onMarketAutoHidden ?? (() => undefined);

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
      getBook: (tokenId) => this.books[tokenId as TokenId],
      getTitle: (marketId) =>
        this.definition?.controls.find(
          (control) => control.marketId === String(marketId),
        )?.title,
      getTokenName: (tokenId) =>
        this.definition?.tokenNames.get(String(tokenId)),
      getOppositeTokenName: (tokenId) =>
        this.definition?.oppositeTokenNames.get(String(tokenId)),
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

  async load(
    definition: ChartDefinition,
    hiddenMarketIds: ReadonlySet<string>,
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeWS();
    if (!this.ownsLoad(generation)) return;

    this.setConnectionStatus("connecting");
    this.books = {};
    this.definition = definition;
    this.activeTokens.clear();
    this.ageView.reset();

    const { event, rawMarkets } = definition;
    const tokenIds = definition.controls.map((control) => control.tokenId);

    for (const control of definition.controls)
      if (!hiddenMarketIds.has(control.marketId))
        this.activeTokens.add(control.tokenId);
    this.ageView.configureMarkets(event, rawMarkets);

    // Recorder registration/metadata is optional and must never gate the live
    // websocket. Apply it only if this load still owns the chart when it lands.
    void fetchRecorderCoverage(tokenIds).then((hydration) => {
      if (!this.ownsLoad(generation)) return;
      this.ageView.setRecordingCoverage(hydration.recordingSinceMsByToken);
      this.reqDraw();
    });

    const events = await this.subscribeWithRetry(tokenIds, generation);
    if (!events) return;
    if (!this.ownsLoad(generation)) {
      await events.close().catch(() => undefined);
      return;
    }

    this.bookEventStream = events;
    this.event = event;
    this.setConnectionStatus("live");
    void this.readEvents(events, generation);
    this.reqDraw();
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.reqDraw();
  }

  setMarketVisible(marketId: string, visible: boolean): void {
    const control = this.definition?.controls.find(
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
    this.loadGeneration++;
    void this.closeWS();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ageView.destroy();
    this.plotter.destroy();
    this.resizeObserver.disconnect();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private pressureColorScale(tokenId: TokenId): SignedVolumeColorScale {
    return this.definition
      ? pressureScaleForToken(this.definition, String(tokenId))
      : DEFAULT_SIGNED_VOLUME_COLOR_SCALE;
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    this.onConnectionStatus(status);
  }

  private autoHideToken(
    tokenId: TokenId,
    reason: AutoHiddenReason,
  ): void {
    if (!this.activeTokens.delete(tokenId)) return;
    const control = this.definition?.controls.find(
      (candidate) => candidate.tokenId === tokenId,
    );
    if (control) this.onMarketAutoHidden(control.marketId, reason);
    this.reqDraw();
  }

  private ownsLoad(generation: number): boolean {
    return !this.destroyed && generation === this.loadGeneration;
  }

  private async closeWS(): Promise<void> {
    const stream = this.bookEventStream;
    this.bookEventStream = null;
    if (stream) await stream.close().catch(() => undefined);
  }

  private async subscribeWithRetry(
    tokenIds: readonly TokenId[],
    generation: number,
  ): Promise<SubscriptionHandle<MarketEvent> | null> {
    while (this.ownsLoad(generation)) {
      try {
        const events = await this.polyMarketClient.subscribe([
          { topic: "market", tokenIds: [...tokenIds] },
        ]);
        if (this.ownsLoad(generation)) return events;
        await events.close().catch(() => undefined);
        return null;
      } catch (error) {
        if (!this.ownsLoad(generation)) return null;
        if (!(error instanceof TransportError)) throw error;
        console.error("Error connecting to websocket; retrying in 1s", error);
        await delay(1_000);
      }
    }
    return null;
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

    for (const [index, market] of (this.event?.markets ?? []).entries()) {
      const tokenId = market.outcomes.yes.tokenId;
      if (!tokenId || !this.activeTokens.has(tokenId)) continue;

      const book = this.books[tokenId] ?? emptyTokenBook();
      const semanticScale =
        this.definition?.pressureScales.get(String(tokenId));
      const yesColor = semanticScale
        ? signedVolumeColor(1, semanticScale)
        : marketColor(this.event!.id, index);
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

  private async readEvents(
    events: SubscriptionHandle<MarketEvent>,
    generation: number,
  ): Promise<void> {
    try {
      for await (const stream of events) {
        if (!this.ownsLoad(generation) || this.bookEventStream !== events) return;

        if (stream.type === "book") {
          const usdToYes = new HalfBook<string>();
          for (const bid of stream.payload.bids) {
            usdToYes.setLevel(bid.price, {
              price: parseFloat(bid.price),
              take: parseFloat(bid.size),
            });
          }

          const yesToUsd = new HalfBook<string>();
          for (const ask of stream.payload.asks) {
            const canonicalPrice = parseFloat(ask.price);
            yesToUsd.setLevel(ask.price, {
              price: 1 / canonicalPrice,
              take: parseFloat(ask.size) * canonicalPrice,
            });
          }
          yesToUsd.setLevel("mint", { price: 1, take: Infinity });

          const tokenId = stream.payload.tokenId as TokenId;
          this.books[tokenId] = { usdToYes, yesToUsd };
          this.ageView.onBookUpdate(tokenId);
        } else if (stream.type === "price_change") {
          const touchedTokens = new Set<TokenId>();
          for (const change of stream.payload.priceChanges) {
            const tokenId = change.tokenId as TokenId;
            const book = this.books[tokenId];
            if (!book) continue;

            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            if (change.side === OrderSide.BUY) {
              book.usdToYes.setLevel(change.price, { price, take: size });
            } else {
              book.yesToUsd.setLevel(change.price, {
                price: 1 / price,
                take: size * price,
              });
            }
            touchedTokens.add(tokenId);
          }

          for (const tokenId of touchedTokens)
            this.ageView.onBookUpdate(tokenId);
        } else if (stream.type === "market_resolved") {
          for (const tokenId of stream.payload.assetIds ?? [])
            this.autoHideToken(tokenId as TokenId, "resolved");
        } else {
          continue;
        }

        this.reqDraw();
      }
    } catch (error) {
      if (this.ownsLoad(generation) && this.bookEventStream === events)
        console.error("Market websocket stream ended with error", error);
    } finally {
      if (this.ownsLoad(generation) && this.bookEventStream === events) {
        this.bookEventStream = null;
        this.setConnectionStatus("disconnected");
      }
    }
  }

}
