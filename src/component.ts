import { fetchRecordedAgeState } from "@/lib/ageRecorderClient";
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
  private event: Event | undefined;
  private books: Record<TokenId, TokenBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private volScale = 4.5;
  private viewMode: ViewMode = "age";
  private searchTimeout: number | undefined;

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
      activeTokens: this.activeTokens, getBook: (tokenId) => this.books[tokenId as TokenId],
      getTitle: (marketId) => this.titles[marketId as MarketId],
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      requestDraw: () => this.reqDraw(),
    });
    this.bindEvents();

    this.resizeObserver = new ResizeObserver(() => {
      this.plotter.resize();
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
        <div class="cpv-overlay" data-ref="overlay"></div>
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
    const { searchInput, canvasWrap, viewMode } = this.refs;

    searchInput.addEventListener("input", () => this.onSearchInput());
    viewMode.addEventListener("change", () => {
      this.viewMode = (viewMode as HTMLSelectElement).value as ViewMode;
      this.reqDraw();
    });
    document.addEventListener("click", this.handleDocumentClick);

    canvasWrap.addEventListener("click", (event) => {
      const rect = this.refs.canvas.getBoundingClientRect();
      this.placeOrder({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    });
  }

  private handleDocumentClick = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest(".cpv-search-container"))
      this.refs.dropdown.style.display = "none";
  };

  async load(event: Event) {
    await this.closeWS();
    this.setDot("connecting");

    this.books = {};
    this.titles = {};
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
    const response = request.value;
    if (!response.ok)
      throw new Error(`Gamma API returned status ${response.status}`);

    const rawEvent = await response.json();
    const rawMarkets: unknown[] = rawEvent.markets ?? [];

    for (const rawMarket of rawMarkets as any[]) {
      if (rawMarket.groupItemTitle)
        this.titles[rawMarket.id] = rawMarket.groupItemTitle;
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

    // GET also registers these tokens with the always-on recorder. Hydration is
    // best-effort, so the chart still works normally when the backend is down.
    this.ageView.hydrate(await fetchRecordedAgeState(tokenIds));

    for (; ;) {
      try {
        this.bookEventStream = await this.polyMarketClient.subscribe([
          { topic: "market", tokenIds },
        ]);
        break;
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        console.error("Error connecting to websocket, retrying...");
      }
    }

    this.event = event;
    this.setDot("live");
    void this.readEvents(this.bookEventStream);
    this.reqDraw();
  }

  destroy() {
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

  private async closeWS() {
    const stream = this.bookEventStream;
    this.bookEventStream = null;
    if (stream) await stream.close();
  }

  private onSearchInput() {
    clearTimeout(this.searchTimeout);
    const query = (this.refs.searchInput as HTMLInputElement).value.trim();
    if (!query) {
      this.refs.dropdown.style.display = "none";
      return;
    }

    this.searchTimeout = window.setTimeout(async () => {
      const suggestions = this.polyMarketClient.search({
        q: query,
        pageSize: 20,
      });
      const page = await suggestions.firstPage();
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
        option.addEventListener("click", () => void this.load(event));
        dropdown.appendChild(option);
      }
      dropdown.style.display = "block";
    }, 250);
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

  private async readEvents(events: SubscriptionHandle<MarketEvent>) {
    for await (const stream of events) {
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
        const nowMs = performance.now();
        this.books[tokenId] = { usdToYes, yesToUsd };
        this.ageView.onBookUpdate(tokenId, nowMs);
      } else if (stream.type === "price_change") {
        const affectedTokens = new Set<TokenId>();
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
          affectedTokens.add(tokenId);
        }

        const nowMs = performance.now();
        for (const tokenId of affectedTokens)
          this.ageView.onBookUpdate(tokenId, nowMs);
      } else if (stream.type === "market_resolved") {
        for (const tokenId of stream.payload.assetIds ?? [])
          this.activeTokens.delete(tokenId as TokenId);
      } else {
        continue;
      }

      this.reqDraw();
    }

    if (this.bookEventStream === events) {
      this.bookEventStream = null;
      this.setDot("disconnected");
    }
  }

  private placeOrder(_screen: { x: number; y: number }) {
    if (this.activeTokens.size === 0) return;
  }
}
