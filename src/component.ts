import { fetchRecorderCoverage } from "@/lib/ageRecorderClient";
import type { ConnectionStatus, ViewMode } from "@/lib/chartState";
import type { EventBundle } from "@/lib/eventBundle";
import { marketColor, marketHue } from "@/lib/math";
import {
  buildNegRiskPalette,
  type NegRiskPalette,
} from "@/lib/negRiskColors";
import {
  buildThresholdPalette,
  semanticYesNeutralNoScale,
  type ThresholdPalette,
} from "@/lib/thresholdColors";
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
import { AgeStripView } from "./ageStrips";
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

export interface PolymarketCPVOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
}

export class PolymarketCPV {
  readonly polyMarketClient: PublicClient;

  private readonly container: HTMLElement;
  private readonly onConnectionStatus: (status: ConnectionStatus) => void;
  private readonly refs: Record<string, HTMLElement> = {};
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly activeTokens = new Set<TokenId>();

  private theme: ChartTheme;
  private plotter!: OrderBookPlotter;
  private ageView!: AgeStripView;
  private raf: number | null = null;
  private pointer: { sx: number; sy: number } | null = null;
  private titles: ReadonlyMap<string, string> = new Map();
  private marketIcons: ReadonlyMap<string, string> = new Map();
  private tokenNames: ReadonlyMap<string, string> = new Map();
  private oppositeTokenNames: ReadonlyMap<string, string> = new Map();
  private event: Event | undefined;
  private negRiskPalette: NegRiskPalette | null = null;
  private thresholdPalette: ThresholdPalette | null = null;
  private semanticPressureScales = new Map<TokenId, SignedVolumeColorScale>();
  private books: Record<TokenId, TokenBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private volScale = 4.5;
  private viewMode: ViewMode = "age";
  private loadGeneration = 0;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    polyMarketClient: PublicClient,
    options: PolymarketCPVOptions = {},
  ) {
    this.polyMarketClient = polyMarketClient;
    this.container = container;
    this.onConnectionStatus =
      options.onConnectionStatus ?? (() => undefined);

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = this.themeQuery.matches ? DARK_THEME : LIGHT_THEME;

    this.buildDOM();
    this.ageView = new AgeStripView({
      canvas: this.refs.canvas as HTMLCanvasElement,
      canvasWrap: this.refs.canvasWrap,
      toggles: this.refs.toggles,
      plotter: this.plotter,
      activeTokens: this.activeTokens,
      getBook: (tokenId) => this.books[tokenId as TokenId],
      getTitle: (marketId) => this.titles.get(String(marketId)),
      getTokenName: (tokenId) => this.tokenNames.get(String(tokenId)),
      getOppositeTokenName: (tokenId) =>
        this.oppositeTokenNames.get(String(tokenId)),
      getPressureColorScale: (tokenId) =>
        this.pressureColorScale(tokenId as TokenId),
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      requestDraw: () => this.reqDraw(),
    });

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.reqDraw();
    });
    this.resizeObserver.observe(this.refs.canvas);
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  private handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = event.matches ? DARK_THEME : LIGHT_THEME;
    this.reqDraw();
  };

  private buildDOM() {
    this.container.innerHTML = `
      <div class="cpv-canvas-wrap" data-ref="canvasWrap">
        <canvas data-ref="canvas"></canvas>
      </div>

      <div class="cpv-toggles" data-ref="toggles"></div>
    `;

    this.container.querySelectorAll("[data-ref]").forEach((element) => {
      const ref = (element as HTMLElement).dataset.ref!;
      this.refs[ref] = element as HTMLElement;
    });

    this.plotter = new OrderBookPlotter(this.refs.canvas as HTMLCanvasElement);
    this.plotter.onZoom = (delta) => {
      if (this.viewMode !== "volume") return;
      this.volScale += delta;
      this.reqDraw();
    };
    this.plotter.onPointer = (pointer) => {
      this.pointer = pointer;
      if (this.viewMode === "volume") this.reqDraw();
    };
  }

  async load(bundle: EventBundle): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeWS();
    if (!this.ownsLoad(generation)) return;

    this.setConnectionStatus("connecting");
    this.books = {};
    this.titles = bundle.marketTitles;
    this.marketIcons = bundle.marketIcons;
    this.tokenNames = bundle.tokenNames;
    this.oppositeTokenNames = bundle.oppositeTokenNames;
    this.negRiskPalette = null;
    this.thresholdPalette = null;
    this.semanticPressureScales.clear();
    this.activeTokens.clear();
    this.ageView.reset();

    const event = bundle.event;
    const rawMarkets = bundle.rawMarkets;

    // Threshold metadata is more specific than the event-level neg-risk flag:
    // some neg-risk groups are nested cumulative partitions, not categorical
    // one-hot outcomes. Detect those first, then fall back to categorical.
    this.thresholdPalette = buildThresholdPalette(event, rawMarkets);
    this.negRiskPalette = this.thresholdPalette
      ? null
      : buildNegRiskPalette(event);

    if (this.thresholdPalette) {
      for (const outcome of this.thresholdPalette.outcomes)
        this.semanticPressureScales.set(
          outcome.yesTokenId as TokenId,
          outcome.scale,
        );
    } else if (!this.negRiskPalette) {
      // Ordinary binary rows do not imply any relationship between their NO
      // outcomes. Give YES its stable per-market semantic hue, but keep NO a
      // neutral gray so large unrelated event groups do not become a wall of
      // complementary magenta.
      for (const [index, market] of event.markets.entries()) {
        const yesTokenId = market.outcomes.yes.tokenId;
        if (!yesTokenId) continue;
        this.semanticPressureScales.set(
          yesTokenId,
          semanticYesNeutralNoScale(marketHue(event.id, index)),
        );
      }

      console.debug("[cpv palette fallback]", {
        eventId: event.id,
        slug: event.slug,
        trading: event.trading,
        markets: event.markets.map((market) => {
          const raw = (rawMarkets as any[]).find(
            (candidate) => String(candidate?.id) === String(market.id),
          );
          return {
            id: market.id,
            question: market.question,
            groupItemTitle: raw?.groupItemTitle,
            groupItemThreshold: raw?.groupItemThreshold,
            groupItemRange: raw?.groupItemRange,
            endDate: raw?.endDate ?? raw?.endDateIso ?? market.state.endDate,
            yesPrice: market.outcomes.yes.price,
            negRisk: market.state.negRisk,
          };
        }),
      });
    }

    const tokenIds = event.markets
      .map((market) =>
        market.state.active ? market.outcomes.yes.tokenId : null,
      )
      .filter((tokenId): tokenId is TokenId => tokenId !== null);

    tokenIds.forEach((tokenId) => this.activeTokens.add(tokenId));
    this.buildToggles(event);
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
    this.container.innerHTML = "";
  }

  private buildToggles(event: Event) {
    const container = this.refs.toggles;
    container.replaceChildren();

    for (const [index, market] of event.markets.entries()) {
      const yesToken = market.outcomes.yes.tokenId;
      if (!yesToken || !this.activeTokens.has(yesToken)) continue;

      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.activeTokens.add(yesToken);
        else this.activeTokens.delete(yesToken);
        this.reqDraw();
      });

      const dot = document.createElement("span");
      const colorScale = this.pressureColorScale(yesToken);
      const color =
        this.negRiskPalette || this.semanticPressureScales.has(yesToken)
          ? signedVolumeColor(1, colorScale)
          : marketColor(event.id, index);
      dot.style.cssText =
        `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`;

      label.append(checkbox, dot);

      const marketIconUrl = this.marketIcons.get(String(market.id));
      if (marketIconUrl) {
        const icon = document.createElement("img");
        icon.className = "cpv-market-icon";
        icon.src = marketIconUrl;
        icon.alt = "";
        icon.setAttribute("aria-hidden", "true");
        icon.loading = "lazy";
        icon.decoding = "async";
        icon.addEventListener(
          "error",
          () => {
            icon.remove();
            this.reqDraw();
          },
          { once: true },
        );
        label.appendChild(icon);
      }

      label.append(this.titles.get(String(market.id)) ?? market.question);
      container.appendChild(label);
    }
  }

  private pressureColorScale(tokenId: TokenId): SignedVolumeColorScale {
    return (
      this.negRiskPalette?.byYesTokenId.get(String(tokenId))?.scale ??
      this.semanticPressureScales.get(tokenId) ??
      DEFAULT_SIGNED_VOLUME_COLOR_SCALE
    );
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    this.onConnectionStatus(status);
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
        this.negRiskPalette?.byYesTokenId.get(String(tokenId))?.scale ??
        this.semanticPressureScales.get(tokenId);
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
    const emptyStyle = PolymarketCPV.boxStyle(view.color, false);
    const filledStyle = PolymarketCPV.boxStyle(view.color, true);
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
        PolymarketCPV.commitBoxRow(pen, level.price, filledHeight, filledStyle);
        fillRemaining -= filledHeight;
      }

      const emptyHeight = rowHeight - filledHeight;
      if (emptyHeight > 0)
        PolymarketCPV.commitBoxRow(pen, level.price, emptyHeight, emptyStyle);

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
            this.activeTokens.delete(tokenId as TokenId);
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
