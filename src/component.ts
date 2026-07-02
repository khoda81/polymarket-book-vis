import { fmtVol, marketColor } from "@/lib/math";
import { BookOrder, HalfBook } from "@/lib/orderBook";
import {
  BoxStyle,
  ChartTheme,
  Frame,
  OrderBookPlotter,
  StackDirection,
} from "@/lib/renderer";
import "@/styles/component.css";
import {
  Market,
  Event,
  OrderSide,
  TokenId,
  TransportError,
  MarketId,
  PublicClient,
} from "@polymarket/client";
import { MarketEvent, SubscriptionHandle } from "@polymarket/client/actions";

type ConnectionStatus = "disconnected" | "connecting" | "live";

interface TokenBook<K = string> {
  /** Give USD, Get YES */
  usdToYes: HalfBook<K>;
  /** Give YES, Get USD */
  yesToUsd: HalfBook<K>;
}

interface BookBoxView {
  readonly direction: StackDirection;
  readonly orders: Iterable<BookOrder>;
  readonly color: string;
  readonly fillDepth?: number;
}

function emptyTokenBook(): TokenBook<string> {
  return { usdToYes: new HalfBook(), yesToUsd: new HalfBook() };
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
  polyMarketClient: PublicClient;

  private theme: ChartTheme;
  private themeQuery: MediaQueryList;

  // TODO: We should not need to store the container
  private container: HTMLElement;
  private refs!: Record<string, HTMLElement>;
  private resizeObserver: ResizeObserver;
  private raf: number | null = null;
  private plotter!: OrderBookPlotter;

  /** Pointer in CSS pixels relative to the canvas. Converted to data on draw. */
  private pointer: { sx: number; sy: number } | null = null;
  private titles: Record<MarketId, string> = {};

  private event: Event | undefined;
  private activeTokens = new Set<TokenId>();
  private books: Record<TokenId, TokenBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private volScale = 4.5;
  private searchTimeout: number | undefined;

  private handleDocumentClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest(".cpv-search-container"))
      this.refs.dropdown.style.display = "none";
  };

  constructor(container: HTMLElement, polyMarketClient: PublicClient) {
    this.polyMarketClient = polyMarketClient;
    this.container = container;
    this.resizeObserver = new ResizeObserver(() => {
      this.plotter.resize();
      this.reqDraw();
    });

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
            placeholder="Search event or paste slug…"
            autocomplete="off"
          />
          <div class="cpv-dropdown" data-ref="dropdown"></div>
        </div>
      </div>

      <div class="cpv-canvas-wrap" data-ref="canvasWrap">
        <canvas data-ref="canvas"></canvas>
        <div class="cpv-overlay" data-ref="overlay"></div>
      </div>

      <div class="cpv-toggles" data-ref="toggles"></div>
    `;

    this.refs = {};
    // TODO: Generate the html and store typed refs instead
    this.container.querySelectorAll("[data-ref]").forEach((el) => {
      this.refs[(el as HTMLElement).dataset.ref!] = el as HTMLElement;
    });
    this.refs.dropdown.setAttribute("role", "listbox");

    this.plotter = new OrderBookPlotter(this.refs.canvas as HTMLCanvasElement);
    this.plotter.onZoom = (delta) => {
      this.volScale = this.volScale + delta;
      this.reqDraw();
    };
    this.plotter.onPointer = (p) => {
      this.pointer = p;
      this.reqDraw();
    };

    this.resizeObserver.observe(this.refs.canvas);
  }

  private bindEvents() {
    const { searchInput, canvasWrap } = this.refs;

    searchInput.addEventListener("input", () => this.onSearchInput());
    document.addEventListener("click", this.handleDocumentClick);

    canvasWrap.addEventListener("click", (e) => {
      const rect = this.refs.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      this.placeOrder({ x: screenX, y: screenY });
    });
  }

  async load(event: Event) {
    await this.closeWS();
    this.setDot("connecting");

    this.books = {};
    this.titles = {};
    this.activeTokens.clear();
    // this.userOrders = [];

    this.refs.title.textContent = event.title ?? "(untitled)";
    (this.refs.searchInput as HTMLInputElement).value =
      event.slug ?? "(untitled)";
    this.refs.dropdown.style.display = "none";

    // TODO: This is a hack until the groupItemTitle is available in the SDK
    // This makes the HTTP request using the SDK's exact internal fetcher.
    const req = await (this.polyMarketClient as any).gamma.get(
      `/events/${event.id}`,
    );
    const res = req.value;
    if (!res.ok) throw new Error(`Gamma API returned status ${res.status}`);

    // Parse the raw fetch response stream
    const rawEvent = await res.json();
    const groupItemIdx: Record<MarketId, number> = {};

    console.debug(rawEvent.markets);
    for (const market of rawEvent.markets ?? []) {
      if (market.groupItemTitle) this.titles[market.id] = market.groupItemTitle;
      if (market.groupItemThreshold)
        groupItemIdx[market.id] = parseFloat(market.groupItemThreshold);
    }

    const compareFn = (a: Market, b: Market) =>
      groupItemIdx[a.id] - groupItemIdx[b.id];

    event.markets.sort(compareFn);
    if (event.display.sortBy === "descending") {
      event.markets.reverse();
    }

    const tokenIds = event.markets
      .map((m) => (m.state.active ? m.outcomes.yes.tokenId : null))
      .filter((t) => t !== null);

    tokenIds.forEach((t) => this.activeTokens.add(t));
    this.buildToggles(event);
    for (;;)
      try {
        this.bookEventStream = await this.polyMarketClient.subscribe([
          { topic: "market", tokenIds },
        ]);
        break;
      } catch (err) {
        if (!(err instanceof TransportError)) throw err;
        // TODO: This is unbounded retry, we should use some retry library that implements exponential back off
        console.error("Error connecting to websocket, retrying...");
      }

    this.event = event;

    this.setDot("live");
    this.readEvents(this.bookEventStream);

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

    this.resizeObserver.disconnect();
  }

  // TODO: These should be probably a dropdown and searchable cause making a checkbox for every market takes too much space
  private buildToggles(event: Event) {
    const container = this.refs.toggles;
    container.innerHTML = "";

    // this.markets.forEach((m, i) => {
    for (const [i, market] of event.markets.entries()) {
      const yesToken = market.outcomes.yes.tokenId;
      if (!yesToken) continue;
      if (!this.activeTokens.has(yesToken)) continue;

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
      const color = marketColor(event.id, i);
      dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}`;

      lbl.appendChild(cb);
      lbl.appendChild(dot);
      lbl.append(this.titles[market.id] ?? market.question);
      container.appendChild(lbl);
    }
  }

  private setDot(s: ConnectionStatus) {
    const { dot, stxt } = this.refs;
    if (s === "live") {
      dot.className = `cpv-dot cpv-dot--live`;
      stxt.textContent = "live";
    } else if (s === "connecting") {
      dot.className = `cpv-dot cpv-dot--conn`;
      stxt.textContent = "connecting...";
    } else if (s === "disconnected") {
      dot.className = `cpv-dot cpv-dot--err`;
      stxt.textContent = "disconnected";
    } else {
      console.error(`Unexpected status ${s}`);
    }
  }

  private async closeWS() {
    if (this.bookEventStream) {
      await this.bookEventStream.close();
      this.bookEventStream = null;
    }
  }

  private onSearchInput() {
    clearTimeout(this.searchTimeout);
    const query = (this.refs.searchInput as HTMLInputElement).value.trim();
    if (!query) {
      this.refs.dropdown.style.display = "none";
      return;
    }

    this.searchTimeout = setTimeout(async () => {
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
      dropdown.innerHTML = "";
      // TODO: We should be able to navigate to the items by using Tab
      for (const event of page.items.events) {
        const div = document.createElement("div");
        div.className = "cpv-dropdown-item";
        div.setAttribute("role", "option"); // Tells screen readers this is a choice
        div.setAttribute("tabindex", "0"); // Makes it focusable via keyboard
        const vol = event.metrics.volume ? parseFloat(event.metrics.volume) : 0;

        const title = document.createTextNode(event.title ?? "(no title)");
        div.appendChild(title);
        div.innerHTML += `<span class="cpv-vol-tag">$${fmtVol(vol)}</span>`;
        div.addEventListener("click", () => this.load(event));
        dropdown.appendChild(div);
      }
      dropdown.style.display = "block";
    }, 250);
  }

  private reqDraw() {
    // TODO: If raf is not null, shouldn't we just return insetad of cancel+request?
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw() {
    this.raf = null;
    const { volScale, theme } = this;

    const yAbsMax = Math.pow(10, volScale);
    const frame = this.plotter.beginFrame(theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: -yAbsMax, max: yAbsMax },
    });

    frame.drawAxes();

    // Convert the stored screen-space pointer to data once, using this
    // frame's transform. No desync possible: we never cache the inverse.
    const pointerData = this.pointer ? frame.toData(this.pointer) : null;

    // User line: an empty book, drawn in a neutral placeholder color.
    // Kept as a placeholder for future user-order rendering.
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

    const markets = this.event?.markets ?? [];
    for (const [i, market] of markets.entries()) {
      const tokenId = market.outcomes.yes.tokenId;
      if (tokenId === null) continue;
      if (!this.activeTokens.has(tokenId)) continue;

      const book = this.books[tokenId] ?? emptyTokenBook();
      const color = marketColor(this.event!.id, i);

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

    if (this.pointer && pointerData) {
      frame.drawPointer(pointerData, this.pointer);
    }
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
      const rowHeight = Math.min(level.value / level.price, remainingHeight);
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

    pen.dispose();
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
        for (const b of stream.payload.bids) {
          const price = parseFloat(b.price);
          const value = parseFloat(b.size) * price;
          usdToYes.setLevel(b.price, { price, value });
        }

        const yesToUsd = new HalfBook<string>();
        for (const a of stream.payload.asks) {
          const price = 1 / parseFloat(a.price);
          const value = parseFloat(a.size);
          yesToUsd.setLevel(a.price, { price, value });
        }

        // If no orders to buy yes, we can always mint more at price 1.0
        yesToUsd.setLevel("mint", { price: 1, value: Infinity });

        this.books[stream.payload.tokenId] = { usdToYes, yesToUsd };
      } else if (stream.type === "price_change") {
        for (const priceChange of stream.payload.priceChanges) {
          const book = this.books[priceChange.tokenId];
          if (!book) continue;

          const { side, price: tick, size } = priceChange;
          const price = parseFloat(tick);
          const value = parseFloat(size);
          if (side === OrderSide.BUY) {
            book.usdToYes.setLevel(tick, { price, value: value * price });
          } else {
            book.yesToUsd.setLevel(tick, { price: 1 / price, value });
          }
        }
      } else if (stream.type === "market_resolved") {
        for (const tokenId of stream.payload.tokenIds ?? [])
          this.activeTokens.delete(tokenId);
      } else continue;

      this.reqDraw();
    }

    this.setDot("disconnected");
  }

  private placeOrder(screen: { x: number; y: number }) {
    const activeIdxs = Array.from(this.activeTokens);
    if (!activeIdxs.length) return;

    // console.debug({ price, shares });
    // if (shares === 0) return;
  }
}
