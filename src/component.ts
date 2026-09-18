import { fetchRecorderCoverage } from "@/lib/ageRecorderClient";
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
import { orderMarkets } from "@/lib/marketOrder";
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
import "@/styles/component.css";
import { AgeStripView } from "./ageStrips";
import {
  Event,
  OrderSide,
  TokenId,
  TransportError,
  MarketId,
  PublicClient,
} from "@polymarket/client";
import { MarketEvent, SubscriptionHandle } from "@polymarket/client/actions";

type ConnectionStatus = "disconnected" | "connecting" | "live";
type ViewMode = "volume" | "age";

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

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function descriptionPreview(description: string): string {
  return (
    description
      .split(/\n+/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

export class PolymarketCPV {
  readonly polyMarketClient: PublicClient;

  private readonly container: HTMLElement;
  private readonly refs: Record<string, HTMLElement> = {};
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly activeTokens = new Set<TokenId>();

  private theme: ChartTheme;
  private plotter!: OrderBookPlotter;
  private ageView!: AgeStripView;
  private raf: number | null = null;
  private pointer: { sx: number; sy: number } | null = null;
  private titles: Record<MarketId, string> = {};
  private tokenNames: Record<TokenId, string> = {};
  private oppositeTokenNames: Record<TokenId, string> = {};
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

  constructor(container: HTMLElement, polyMarketClient: PublicClient) {
    this.polyMarketClient = polyMarketClient;
    this.container = container;

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
      getTitle: (marketId) => this.titles[marketId as MarketId],
      getTokenName: (tokenId) => this.tokenNames[tokenId as TokenId],
      getOppositeTokenName: (tokenId) =>
        this.oppositeTokenNames[tokenId as TokenId],
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
    this.container.classList.add("cpv-wrap");
    this.container.innerHTML = `
      <h2 class="cpv-sr-only">Polymarket market-state visualization</h2>

      <div class="cpv-header">
        <div class="cpv-heading">
          <div class="cpv-title-line">
            <h5 class="cpv-title" data-ref="title">Loading…</h5>
            <a
              class="cpv-event-link"
              data-ref="eventLink"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open event on Polymarket"
              title="Open on Polymarket"
            >↗</a>
          </div>
          <button
            type="button"
            class="cpv-event-slug"
            data-ref="eventSlug"
            title="Copy event slug"
          ></button>
        </div>
        <div class="cpv-dot cpv-dot--conn" data-ref="dot"></div>
        <span class="cpv-stxt" data-ref="stxt">connecting…</span>
      </div>

      <details class="cpv-event-description" data-ref="descriptionPanel" hidden>
        <summary>
          <span class="cpv-event-description-preview" data-ref="descriptionPreview">
            Description
          </span>
        </summary>
        <div class="cpv-event-description-body" data-ref="description"></div>
      </details>

      <div class="cpv-canvas-wrap" data-ref="canvasWrap">
        <canvas data-ref="canvas"></canvas>
      </div>

      <div class="cpv-toggles" data-ref="toggles"></div>
    `;

    this.container.querySelectorAll("[data-ref]").forEach((element) => {
      const ref = (element as HTMLElement).dataset.ref!;
      this.refs[ref] = element as HTMLElement;
    });

    this.refs.eventSlug.addEventListener("click", () => {
      const slug = this.refs.eventSlug.textContent?.trim();
      if (!slug) return;
      void navigator.clipboard?.writeText(slug).catch(() => undefined);
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

  async load(event: Event): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeWS();
    if (!this.ownsLoad(generation)) return;

    this.setDot("connecting");
    this.books = {};
    this.titles = {};
    this.tokenNames = {};
    this.oppositeTokenNames = {};
    this.negRiskPalette = null;
    this.thresholdPalette = null;
    this.semanticPressureScales.clear();
    this.activeTokens.clear();
    this.ageView.reset();

    this.refs.title.textContent = event.title ?? "(untitled)";

    const eventSlug = event.slug?.trim() || null;
    const eventLink = this.refs.eventLink as HTMLAnchorElement;
    const slugElement = this.refs.eventSlug as HTMLButtonElement;
    if (eventSlug) {
      eventLink.href = `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
      eventLink.hidden = false;
      slugElement.textContent = eventSlug;
      slugElement.hidden = false;
    } else {
      eventLink.removeAttribute("href");
      eventLink.hidden = true;
      slugElement.textContent = "";
      slugElement.hidden = true;
    }

    // groupItemTitle/Threshold are not exposed by the SDK yet, so use its
    // internal Gamma fetcher for the display metadata we need.
    const request = await (this.polyMarketClient as any).gamma.get(
      `/events/${event.id}`,
    );
    if (!this.ownsLoad(generation)) return;

    const response = request.value;
    if (!response.ok)
      throw new Error(`Gamma API returned status ${response.status}`);

    const rawEvent = await response.json();
    if (!this.ownsLoad(generation)) return;

    const description =
      typeof rawEvent.description === "string"
        ? rawEvent.description.trim()
        : "";
    const subtitle =
      typeof rawEvent.subtitle === "string" ? rawEvent.subtitle.trim() : "";
    const descriptionPanel = this.refs.descriptionPanel as HTMLDetailsElement;
    this.refs.description.textContent = description;
    this.refs.descriptionPreview.textContent =
      subtitle || descriptionPreview(description) || "Description";
    descriptionPanel.hidden = description.length === 0;
    if (!description) descriptionPanel.open = false;

    const rawMarkets: unknown[] = rawEvent.markets ?? [];

    for (const rawMarket of rawMarkets as any[]) {
      if (rawMarket.groupItemTitle)
        this.titles[rawMarket.id] = rawMarket.groupItemTitle;

      const outcomes = parseStringArray(rawMarket.outcomes);
      const tokenIds = parseStringArray(rawMarket.clobTokenIds);
      for (let i = 0; i < Math.min(outcomes.length, tokenIds.length); i++) {
        const tokenId = tokenIds[i];
        const outcome = outcomes[i];
        if (!tokenId || !outcome) continue;

        this.tokenNames[tokenId as TokenId] = outcome;
        if (outcomes.length === 2 && tokenIds.length === 2) {
          const opposite = outcomes[1 - i];
          if (opposite)
            this.oppositeTokenNames[tokenId as TokenId] = opposite;
        }
      }
    }

    event = { ...event, markets: orderMarkets(event, rawMarkets) };
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
    this.setDot("live");
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
    this.container.classList.remove("cpv-wrap");
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

      label.append(checkbox, dot, this.titles[market.id] ?? market.question);
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

  private setDot(status: ConnectionStatus) {
    const { dot, stxt } = this.refs;
    if (status === "live") {
      dot.className = "cpv-dot cpv-dot--live";
      stxt.textContent = "live";
    } else if (status === "connecting") {
      dot.className = "cpv-dot cpv-dot--conn";
      stxt.textContent = "connecting...";
    } else {
      dot.className = "cpv-dot cpv-dot--err";
      stxt.textContent = "disconnected";
    }
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
        this.setDot("disconnected");
      }
    }
  }

}
