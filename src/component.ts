import { fetchRecorderCoverage } from "@/lib/ageRecorderClient";
import { fmtVol, marketColor } from "@/lib/math";
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
  private books: Record<TokenId, TokenBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private volScale = 4.5;
  private viewMode: ViewMode = "age";
  private searchTimeout: number | undefined;
  private loadGeneration = 0;
  private searchGeneration = 0;
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
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      requestDraw: () => this.reqDraw(),
    });
    this.bindEvents();

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
        <h5 class="cpv-title" data-ref="title">Loading…</h5>
        <div class="cpv-dot cpv-dot--conn" data-ref="dot"></div>
        <span class="cpv-stxt" data-ref="stxt">connecting…</span>
      </div>

      <div class="cpv-top-controls">
        <div class="cpv-search-container">
          <input
            type="text"
            class="cpv-search-input"
            data-ref="searchInput"
            placeholder="Search events…"
            autocomplete="off"
          />
          <div class="cpv-dropdown" data-ref="dropdown"></div>
        </div>
        <label class="cpv-view-control">
          View
          <select data-ref="viewMode" aria-label="Visualization mode">
            <option value="age">age</option>
            <option value="volume">volume</option>
          </select>
        </label>
      </div>

      <div class="cpv-canvas-wrap" data-ref="canvasWrap">
        <canvas data-ref="canvas"></canvas>
      </div>

      <div class="cpv-toggles" data-ref="toggles"></div>
    `;

    this.container.querySelectorAll("[data-ref]").forEach((element) => {
      const ref = (element as HTMLElement).dataset.ref!;
      this.refs[ref] = element as HTMLElement;
    });
    this.refs.dropdown.setAttribute("role", "listbox");

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

  private bindEvents() {
    const { searchInput, viewMode } = this.refs;

    searchInput.addEventListener("input", () => this.onSearchInput());
    viewMode.addEventListener("change", () => {
      this.viewMode = (viewMode as HTMLSelectElement).value as ViewMode;
      this.reqDraw();
    });
    document.addEventListener("click", this.handleDocumentClick);
  }

  private handleDocumentClick = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest(".cpv-search-container"))
      this.refs.dropdown.style.display = "none";
  };

  async load(event: Event): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeWS();
    if (!this.ownsLoad(generation)) return;

    this.setDot("connecting");
    this.books = {};
    this.titles = {};
    this.tokenNames = {};
    this.oppositeTokenNames = {};
    this.activeTokens.clear();
    this.ageView.reset();

    this.refs.title.textContent = event.title ?? "(untitled)";
    (this.refs.searchInput as HTMLInputElement).value =
      event.slug ?? "(untitled)";
    this.refs.dropdown.style.display = "none";

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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration++;
    this.searchGeneration++;
    void this.closeWS();
    clearTimeout(this.searchTimeout);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ageView.destroy();
    this.plotter.destroy();
    this.resizeObserver.disconnect();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
    document.removeEventListener("click", this.handleDocumentClick);
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
      const color = marketColor(event.id, index);
      dot.style.cssText =
        `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`;

      label.append(checkbox, dot, this.titles[market.id] ?? market.question);
      container.appendChild(label);
    }
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

  private onSearchInput() {
    clearTimeout(this.searchTimeout);
    const generation = ++this.searchGeneration;
    const query = (this.refs.searchInput as HTMLInputElement).value.trim();
    if (!query) {
      this.refs.dropdown.style.display = "none";
      return;
    }

    this.searchTimeout = window.setTimeout(() => {
      void this.runSearch(query, generation);
    }, 250);
  }

  private async runSearch(query: string, generation: number): Promise<void> {
    try {
      const suggestions = this.polyMarketClient.search({
        q: query,
        pageSize: 20,
      });
      const page = await suggestions.firstPage();
      if (this.destroyed || generation !== this.searchGeneration) return;

      if (!page.totalCount) {
        this.refs.dropdown.style.display = "none";
        return;
      }

      const dropdown = this.refs.dropdown;
      dropdown.replaceChildren();
      for (const event of page.items.events) {
        const option = document.createElement("div");
        option.className = "cpv-dropdown-item";
        option.setAttribute("role", "option");
        option.tabIndex = 0;

        const volume = event.metrics.volume
          ? parseFloat(event.metrics.volume)
          : 0;
        option.append(document.createTextNode(event.title ?? "(no title)"));
        const volumeTag = document.createElement("span");
        volumeTag.className = "cpv-vol-tag";
        volumeTag.textContent = `$${fmtVol(volume)}`;
        option.appendChild(volumeTag);
        option.addEventListener("click", () => {
          this.searchGeneration++;
          dropdown.style.display = "none";
          void this.load(event).catch((error) => {
            if (this.destroyed) return;
            console.error("Could not load selected event", error);
            this.setDot("disconnected");
          });
        });
        dropdown.appendChild(option);
      }
      dropdown.style.display = "block";
    } catch (error) {
      if (this.destroyed || generation !== this.searchGeneration) return;
      console.error("Market search failed", error);
      this.refs.dropdown.style.display = "none";
    }
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
      const color = marketColor(this.event!.id, index);
      this.drawBookView(frame, {
        direction: "up",
        orders: book.usdToYes.asOrders(),
        color,
        fillDepth: pointerData ? Math.max(pointerData.y, 0) : undefined,
      });
      this.drawBookView(frame, {
        direction: "down",
        orders: book.yesToUsd.asSellOrders(),
        color,
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
