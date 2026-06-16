import { fmtVol, hslColor } from "@/lib/math";
import { FullOrderBook, OrderBook } from "@/lib/orderBook";
import { OrderBookPlotter, type PlotDrawState } from "@/lib/renderer";
import "@/styles/component.css";
import {
  createPublicClient,
  Market,
  Event,
  OrderSide,
} from "@polymarket/client";
import { MarketEvent, SubscriptionHandle } from "@polymarket/client/actions";

enum ConnectionStatus {
  Error = "disconnected",
  Connecting = "connecting",
  Live = "live",
}

export class PolymarketCPV {
  polyMarketClient = createPublicClient();

  private container: HTMLElement;
  private refs!: Record<string, HTMLElement>;
  private plotter!: OrderBookPlotter;

  private markets: Market[] = [];
  private activeMarkets = new Set<number>();
  private books: Record<string, FullOrderBook<string>> = {};
  private bookEventStream: SubscriptionHandle<MarketEvent> | null = null;
  private raf: number | null = null;
  // private userOrders: UserOrder[] = [];
  private volZoom = 3.5;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  private handleDocumentClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest(".cpv-search-container"))
      (this.refs.dropdown as HTMLElement).style.display = "none";
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.buildDOM();
    this.bindEvents();
  }

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

    this.plotter = new OrderBookPlotter(
      this.refs.canvas as HTMLCanvasElement,
      this.refs.overlay as HTMLDivElement,
      () => this.reqDraw(),
    );
  }

  private bindEvents() {
    const { searchInput, dropdown, canvasWrap } = this.refs;

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
        let delta = e.deltaY;
        if (e.deltaMode === 1) delta *= 16;
        else if (e.deltaMode === 2) delta *= 100;
        this.volZoom = Math.max(0, this.volZoom + delta * 0.002);
        this.reqDraw();
      },
      { passive: false },
    );
  }

  async load(event: Event) {
    await this.closeWS();
    this.setDot(ConnectionStatus.Connecting);

    this.books = {};
    this.markets = [];
    this.activeMarkets.clear();
    // this.userOrders = [];

    (this.refs.title as HTMLElement).textContent = event.title ?? "(untitled)";
    (this.refs.searchInput as HTMLInputElement).value =
      event.slug ?? "(untitled)";
    (this.refs.dropdown as HTMLElement).style.display = "none";

    this.markets = event.markets.filter((m) => !m.state.closed);

    this.buildToggles();
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
    this.container.classList.remove("cpv-wrap");
    document.removeEventListener("click", this.handleDocumentClick);
  }

  // TODO: These should be probably a dropdown and searchable cause making a checkbox for every market takes too much space
  private buildToggles() {
    const container = this.refs.toggles as HTMLElement;
    container.innerHTML = "";

    this.markets.forEach((m, i) => {
      this.activeMarkets.add(i);

      const lbl = document.createElement("label");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        cb.checked ? this.activeMarkets.add(i) : this.activeMarkets.delete(i);
        this.reqDraw();
      });

      const dot = document.createElement("span");
      dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${hslColor(i)}`;

      lbl.appendChild(cb);
      lbl.appendChild(dot);
      lbl.append(" " + m.outcomes.yes.label);
      container.appendChild(lbl);
    });
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

  private async performDraw() {
    // this.plotter.draw(state);
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private async readEvents(events: SubscriptionHandle<MarketEvent>) {
    for await (const stream of events) {
      if (stream.type === "book") {
        const asks = new OrderBook<string>();
        for (const a of stream.payload.asks) {
          asks.insertOrder(a.price, parseFloat(a.price), parseFloat(a.size));
        }

        const bids = new OrderBook<string>();
        for (const b of stream.payload.bids) {
          bids.insertOrder(b.price, parseFloat(b.price), parseFloat(b.size));
        }

        console.log(
          `Creating event for tokenId: ${stream.payload.tokenId}, event: ${stream.type}`,
        );
        this.books[stream.payload.tokenId] = new FullOrderBook(asks, bids);
      } else if (stream.type === "price_change") {
        for (const priceChange of stream.payload.priceChanges) {
          const book = this.books[priceChange.tokenId];
          if (!book) {
            // console.warn(
            //   `Received price change for unknown tokenId: ${priceChange.tokenId}`,
            // );
            continue;
          }

          const { side, price, size } = priceChange;
          if (side === OrderSide.BUY)
            book.asks.insertOrder(price, parseFloat(price), parseFloat(size));
          else
            book.bids.insertOrder(price, parseFloat(price), parseFloat(size));

          console.log(
            `Received price change for tokenId: ${priceChange.tokenId}, side: ${priceChange.side}, book:`,
            book,
          );
        }
      }
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
