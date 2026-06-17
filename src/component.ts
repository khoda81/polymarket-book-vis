import { fmtVol, idToColor } from "@/lib/math";
import { EventBook, BuyOrders } from "@/lib/orderBook";
import { OrderBookPlotter, RenderFrameConfig } from "@/lib/renderer";
import "@/styles/component.css";
import {
  createPublicClient,
  Market,
  Event,
  OrderSide,
  TokenId,
  TransportError,
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
  private pointer: { screen: DOMPoint; data: DOMPoint } | null = null;

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
    this.plotter.onZoom = (delta) => {
      this.volZoom = this.volZoom + delta;
      this.reqDraw();
    };
    this.plotter.onHover = (point) => {
      this.pointer = point
        ? { screen: point, data: this.plotter.screenToDataPoint(point)! }
        : null;
      this.reqDraw();
    };
  }

  private bindEvents() {
    const { searchInput, dropdown, canvasWrap, canvas } = this.refs;

    (searchInput as HTMLInputElement).addEventListener("input", () =>
      this.onSearchInput(),
    );

    document.addEventListener("click", this.handleDocumentClick);

    (canvasWrap as HTMLElement).addEventListener("click", (e) => {
      const rect = (
        this.refs.canvas as HTMLCanvasElement
      ).getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const screenX = (e.clientX - rect.left) * dpr;
      const screenY = (e.clientY - rect.top) * dpr;

      this.placeOrder(new DOMPoint(screenX, screenY));
    });
  }

  async load(event: Event) {
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

    if (event.display.sortBy === "descending") {
      event.markets.sort((a, b) => b.id.localeCompare(a.id));
    } else {
      event.markets.sort((a, b) => a.id.localeCompare(b.id));
    }
    this.markets = event.markets.filter((m) => !m.state.closed);

    this.buildToggles();
    for (;;)
      try {
        this.bookEventStream = await this.polyMarketClient.subscribe([
          {
            topic: "market",
            tokenIds: this.markets
              .map((m) => m.outcomes.yes.tokenId)
              .filter((t) => t !== null),
          },
        ]);
        break;
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        console.error("Error connecting to websocket, retrying");
      }

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
      const color = this.tokenColor(i);
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

    // Draw user line:
    this.plotter.drawCurve(
      frameCtx,
      new EventBook(new BuyOrders<string>(), new BuyOrders<string>()),
      "white",
    );

    for (const [i, market] of this.markets.entries()) {
      const tokenId = market.outcomes.yes.tokenId;

      if (tokenId === null) continue;
      if (!this.activeTokens.has(tokenId)) continue;

      const book =
        this.books[tokenId] ??
        new EventBook(new BuyOrders<string>(), new BuyOrders<string>());

      this.plotter.drawCurve(frameCtx, book, this.tokenColor(i));
    }
  }

  private tokenColor(id: number): string {
    const tokenId = BigInt(id);
    const PRIME = 2147483647n;
    const color = idToColor(Number(tokenId % PRIME));
    console.debug({ yesToken: id, color, id: Number(tokenId % PRIME) });
    return color;
  }

  private async readEvents(events: SubscriptionHandle<MarketEvent>) {
    for await (const stream of events) {
      if (stream.type === "book") {
        const usdToYes = new BuyOrders<string>();
        for (const b of stream.payload.bids) {
          const price = parseFloat(b.price);
          usdToYes.insertBid(b.price, price, parseFloat(b.size) * price);
        }

        const yesToUsd = new BuyOrders<string>();
        for (const a of stream.payload.asks) {
          const price = 1 / parseFloat(a.price);
          // TODO: Should this be a multiply or divide?
          yesToUsd.insertBid(a.price, price, parseFloat(a.size));
        }

        this.books[stream.payload.tokenId] = new EventBook(usdToYes, yesToUsd);
      } else if (stream.type === "price_change") {
        for (const priceChange of stream.payload.priceChanges) {
          const book = this.books[priceChange.tokenId];
          if (!book) continue;

          const { side, price: tick, size } = priceChange;
          const price = parseFloat(tick);
          if (side === OrderSide.BUY)
            book.usdToYes.insertBid(tick, price, parseFloat(size) * price);
          else book.yesToUsd.insertBid(tick, 1 / price, parseFloat(size));
        }
      } else continue;

      this.reqDraw();
    }

    this.setDot(ConnectionStatus.Error);
  }

  private placeOrder(point: DOMPoint) {
    const activeIdxs = Array.from(this.activeTokens);
    if (!activeIdxs.length) return;

    const dataPoint = this.plotter.screenToDataPoint(point);
    if (!dataPoint) return;

    const price = dataPoint.x;
    const shares = dataPoint.y;

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
