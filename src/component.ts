import { fmtVol, hslColor } from "@/lib/math";
import { EventBook, OrderBook } from "@/lib/orderBook";
import {
  FrameContext,
  OrderBookPlotter,
  RenderFrameConfig,
} from "@/lib/renderer";
import "@/styles/component.css";
import {
  createPublicClient,
  Market,
  Event,
  OrderSide,
  TokenId,
  GammaMarket,
} from "@polymarket/client";
import { MarketEvent, SubscriptionHandle } from "@polymarket/client/actions";

enum ConnectionStatus {
  Error = "disconnected",
  Connecting = "connecting",
  Live = "live",
}

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
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
  polyMarketClient = createPublicClient();

  private theme: ChartTheme;
  private themeQuery: MediaQueryList;
  private container: HTMLElement;
  private refs!: Record<string, HTMLElement>;
  private plotter!: OrderBookPlotter;

  private markets: Market[] = [];
  private activeTokens = new Set<TokenId>();
  private books: Record<string, EventBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private raf: number | null = null;
  // private userOrders: UserOrder[] = [];
  private volZoom = 4.5;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  private handleDocumentClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest(".cpv-search-container"))
      (this.refs.dropdown as HTMLElement).style.display = "none";
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
    this.bindEvents();

    // 1. Setup system theme listener
    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = this.themeQuery.matches ? DARK_THEME : LIGHT_THEME;

    // 2. Listen for OS-level toggles
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  private handleThemeChange = (e: MediaQueryListEvent) => {
    this.theme = e.matches ? DARK_THEME : LIGHT_THEME;
    this.reqDraw(); // Force a redraw immediately
  };

  private buildDOM() {
    this.container.classList.add("cpv-wrap");
    this.container.innerHTML = `
      <h2 class="cpv-sr-only">Polymarket signed cumulative price-volume</h2>

      <div class="cpv-header">
        <div class="cpv-title" data-ref="title">Loading…</div>
        <div class="cpv-dot cpv-dot--conn" data-ref="dot"></div>
        <span class="cpv-stxt" data-ref="stxt">connecting…</span>
      </div>

      <div class="cpv-controls">
        <div class="cpv-top-controls">
          <div class="cpv-search-container">
            <input
              type="text"
              class="cpv-search-input"
              data-ref="searchInput"
              placeholder="Search event or paste slug…"
              autocomplete="off"
            />
            <div class="cpv-dropdown" data-ref="dropdown"></div>
          </div>
        </div>
        <div class="cpv-toggles" data-ref="toggles"></div>
      </div>

      <div style="height:8px"></div>
      <div class="cpv-canvas-wrap" data-ref="canvasWrap">
        <canvas data-ref="canvas"></canvas>
        <div class="cpv-overlay" data-ref="overlay"></div>
      </div>
    `;

    this.refs = {};
    this.container.querySelectorAll("[data-ref]").forEach((el) => {
      this.refs[(el as HTMLElement).dataset.ref!] = el as HTMLElement;
    });

    this.plotter = new OrderBookPlotter(this.refs.canvas as HTMLCanvasElement);
    this.plotter.onZoom = (_delta) => this.reqDraw();
  }

  private bindEvents() {
    const { searchInput, dropdown, canvasWrap, canvas } = this.refs;

    (searchInput as HTMLInputElement).addEventListener("input", () =>
      this.onSearchInput(),
    );

    document.addEventListener("click", this.handleDocumentClick);

    (canvasWrap as HTMLElement).addEventListener("click", (e) => {
      const r = (this.refs.canvas as HTMLCanvasElement).getBoundingClientRect();
      const clickX = e.clientX - r.left;
      const clickY = e.clientY - r.top;
      this.placeOrder(new DOMPoint(clickX, clickY));
    });

    (canvasWrap as HTMLElement).addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        let delta = e.deltaY * 0.002;
        // Handle different wheel modes (pixels, lines, pages)
        if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          const computedLineHeight =
            parseFloat(getComputedStyle(canvasWrap).lineHeight) || 16;
          const lineHeight = window.devicePixelRatio * computedLineHeight;
          delta *= lineHeight;
        } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          // Use the container's height for a "page" scroll, or window.innerHeight
          delta *= canvas.clientHeight;
        }
        this.volZoom = this.volZoom + delta;
        this.reqDraw();
      },
      { passive: false },
    );
  }

  async load(event: Event) {
    console.log(event);
    await this.closeWS();
    this.setDot(ConnectionStatus.Connecting);

    this.books = {};
    this.markets = [];
    this.activeTokens.clear();
    // this.userOrders = [];

    (this.refs.title as HTMLElement).textContent = event.title ?? "(untitled)";
    (this.refs.searchInput as HTMLInputElement).value =
      event.slug ?? "(untitled)";
    (this.refs.dropdown as HTMLElement).style.display = "none";

    this.markets = event.markets.filter((m) => !m.state.closed);

    this.buildToggles();
    // TODO: Sort markets based on event.display.sortBy === "ascending";
    this.bookEventStream = await this.polyMarketClient.subscribe([
      {
        topic: "market",
        tokenIds: this.markets
          .map((m) => m.outcomes.yes.tokenId)
          .filter((t) => t !== null),
      },
    ]);

    this.readEvents(this.bookEventStream);
    this.setDot(ConnectionStatus.Live);

    this.reqDraw();
  }

  destroy() {
    this.closeWS();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.plotter.destroy();
    this.container.innerHTML = "";
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
    this.container.classList.remove("cpv-wrap");
    document.removeEventListener("click", this.handleDocumentClick);
  }

  // TODO: These should be probably a dropdown and searchable cause making a checkbox for every market takes too much space
  private buildToggles() {
    const container = this.refs.toggles as HTMLElement;
    container.innerHTML = "";

    // this.markets.forEach((m, i) => {
    for (const [i, market] of this.markets.entries()) {
      const yesToken = market.outcomes.yes.tokenId;
      if (!yesToken) continue;

      this.activeTokens.add(yesToken);

      const lbl = document.createElement("label");
      const cb = document.createElement("input");

      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        cb.checked
          ? this.activeTokens.add(yesToken)
          : this.activeTokens.delete(yesToken);
        this.reqDraw();
      });

      const dot = document.createElement("span");
      const tokenId = market.outcomes.yes.tokenId;
      if (!tokenId) continue;
      const color = this.tokenColor(tokenId);
      dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`;

      lbl.appendChild(cb);
      lbl.appendChild(dot);
      lbl.append(" " + market.question);
      container.appendChild(lbl);
    }
  }

  private static readonly STATUS_DISPLAY: Record<
    ConnectionStatus,
    [string, string]
  > = {
    [ConnectionStatus.Live]: ["live", "live"],
    [ConnectionStatus.Error]: ["err", "error"],
    [ConnectionStatus.Connecting]: ["conn", "connecting…"],
  };

  private setDot(s: ConnectionStatus) {
    const { dot, stxt } = this.refs;
    const [cls, txt] = PolymarketCPV.STATUS_DISPLAY[s];
    (dot as HTMLElement).className = `cpv-dot cpv-dot--${cls}`;
    (stxt as HTMLElement).textContent = txt;
  }

  private async closeWS() {
    if (this.bookEventStream) {
      await this.bookEventStream.close();
      this.bookEventStream = null;
    }
  }

  private onSearchInput() {
    clearTimeout(this.searchTimeout ?? undefined);
    const query = (this.refs.searchInput as HTMLInputElement).value.trim();
    if (!query) {
      (this.refs.dropdown as HTMLElement).style.display = "none";
      return;
    }

    this.searchTimeout = setTimeout(async () => {
      const suggestions = this.polyMarketClient.search({
        q: query,
        pageSize: 20,
      });
      const page = await suggestions.firstPage();
      if (!page.totalCount) {
        (this.refs.dropdown as HTMLElement).style.display = "none";
        return;
      }

      const dropdown = this.refs.dropdown as HTMLElement;
      dropdown.innerHTML = "";
      for (const event of page.items.events) {
        const div = document.createElement("div");
        div.className = "cpv-dropdown-item";
        const vol = event.metrics.volume ? parseFloat(event.metrics.volume) : 0;
        div.innerHTML = `<span>${event.title}</span><span class="cpv-vol-tag">$${fmtVol(vol)}</span>`;
        div.addEventListener("click", () => this.load(event));
        dropdown.appendChild(div);
      }
      dropdown.style.display = "block";
    }, 250);
  }

  private reqDraw() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private toPlotState(): RenderFrameConfig {
    return {
      volZoom: this.volZoom,
      // TODO: Where do we get the theme from?
      theme: this.theme,
      // TODO: So we plan to store the pointer in state now?
      pointer: this.pointer,
    };
  }

  private performDraw() {
    this.raf = null;
    const state = this.toPlotState();
    const frameCtx = this.plotter.beginFrame(state);
    this.plotter.drawAxes(frameCtx);

    for (const tokenId of this.activeTokens) {
      const book = this.books[tokenId]!;
      if (!book)
        console.error(`Could not find book for ${tokenId}:`, this.books);
      this.plotter.drawCurve(frameCtx, book, this.tokenColor(tokenId));
    }

    // this.plotter.drawPointer();
  }

  private tokenColor(yesToken: TokenId): string {
    return hslColor(BigInt(yesToken));
  }

  private async readEvents(events: SubscriptionHandle<MarketEvent>) {
    for await (const stream of events) {
      if (stream.type === "book") {
        const usdToYes = new OrderBook<string>();
        for (const b of stream.payload.bids) {
          const price = parseFloat(b.price);
          usdToYes.insertOrder(b.price, price, parseFloat(b.size) * price);
        }

        const yesToUsd = new OrderBook<string>();
        for (const a of stream.payload.asks) {
          const price = 1 / parseFloat(a.price);
          // TODO: Should this be a multiply or divide?
          yesToUsd.insertOrder(a.price, price, parseFloat(a.size));
        }

        this.books[stream.payload.tokenId] = new EventBook(usdToYes, yesToUsd);
      } else if (stream.type === "price_change") {
        for (const priceChange of stream.payload.priceChanges) {
          const book = this.books[priceChange.tokenId];
          if (!book) {
            // console.warn(
            //   `Received price change for unknown tokenId: ${priceChange.tokenId}`,
            // );
            continue;
          }

          const { side, price: id, size } = priceChange;
          const price = parseFloat(id);
          if (side === OrderSide.BUY)
            book.usdToYes.insertOrder(id, price, parseFloat(size) * price);
          else book.yesToUsd.insertOrder(id, 1 / price, parseFloat(size));
        }
      } else continue;

      this.reqDraw();
    }
  }

  private placeOrder(point: DOMPoint) {
    const activeIdxs = Array.from(this.activeMarkets);
    if (!activeIdxs.length) return;

    const dataPoint = this.plotter.screenToDataPoint(point);
    if (!dataPoint) return;

    const price = point.x;
    const shares = point.y;

    console.debug({ price, shares });
    if (shares === 0) return;

    // const order: UserOrder = {
    //   id: crypto.randomUUID(),
    //   price,
    //   shares,
    //   marketIdx: activeIdxs[0],
    // };

    // this.userOrders = [...this.userOrders, order];
    // this.reqDraw();
  }
}
