import { fetchSearchSuggestions, fetchEventBySlug } from "@/lib/api";
import { fmtVol, hslColor } from "@/lib/math";
import type { OrderBook } from "@/lib/ws";
import { ConnectionStatus, MarketWS } from "@/lib/ws";
import { draw, type DrawState, type MarketInfo } from "@/lib/renderer";
import "@/styles/component.css";

export class PolymarketCPV {
  private container: HTMLElement;
  private refs!: Record<string, HTMLElement>;
  private ctx!: CanvasRenderingContext2D;

  private markets: MarketInfo[] = [];
  private activeMarkets = new Set<number>();
  private books: Record<string, OrderBook> = {};
  private ws: MarketWS | null = null;
  private raf: number | null = null;
  private mx: number | null = null;
  private my: number | null = null;
  private volZoom = 3.5;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, opts: { slug?: string } = {}) {
    this.container = container;
    this.buildDOM();
    this.bindEvents();
    if (opts.slug) this.load(opts.slug);
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
        <div class="cpv-tip" data-ref="tip"></div>
        <div class="cpv-overlay" data-ref="overlay"></div>
      </div>
    `;

    this.refs = {};
    this.container.querySelectorAll("[data-ref]").forEach((el) => {
      this.refs[(el as HTMLElement).dataset.ref!] = el as HTMLElement;
    });

    this.ctx = (this.refs.canvas as HTMLCanvasElement).getContext("2d")!;
  }

  private bindEvents() {
    const { searchInput, dropdown, canvasWrap } = this.refs;

    (searchInput as HTMLInputElement).addEventListener("input", () =>
      this.onSearchInput(),
    );

    document.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".cpv-search-container"))
        (dropdown as HTMLElement).style.display = "none";
    });

    (canvasWrap as HTMLElement).addEventListener("mousemove", (e) => {
      const r = (this.refs.canvas as HTMLCanvasElement).getBoundingClientRect();
      this.mx = e.clientX - r.left;
      this.my = e.clientY - r.top;
      this.reqDraw();
    });

    (canvasWrap as HTMLElement).addEventListener("mouseleave", () => {
      this.mx = null;
      this.my = null;
      this.reqDraw();
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

  async load(slug: string) {
    try {
      this.closeWS();
      this.books = {};
      this.markets = [];
      this.activeMarkets.clear();

      const event = await fetchEventBySlug(slug);

      (this.refs.title as HTMLElement).textContent = event.title;
      (this.refs.searchInput as HTMLInputElement).value = event.slug;
      (this.refs.dropdown as HTMLElement).style.display = "none";

      for (const market of event.markets) {
        if (market.closed) continue;
        this.markets.push(market);
      }

      this.markets.sort(
        (a, b) => Date.parse(a.endDate) - Date.parse(b.endDate),
      );

      this.buildToggles();
      this.ws = new MarketWS(
        this.markets.flatMap((m) => m.clobTokenIds),
        (s) => this.setDot(s),
        (b) => {
          this.books = b;
          this.reqDraw();
        },
      );
      this.reqDraw();
    } catch (err) {
      console.error(err);
      this.setDot(ConnectionStatus.Err);
      (this.refs.title as HTMLElement).textContent =
        "Error: " + (err as Error).message;
    }
  }

  destroy() {
    this.closeWS();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.container.innerHTML = "";
    this.container.classList.remove("cpv-wrap");
  }

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
      lbl.append(" " + m.groupItemTitle);
      container.appendChild(lbl);
    });
  }

  private static readonly STATUS_DISPLAY: Record<
    ConnectionStatus,
    [string, string]
  > = {
    [ConnectionStatus.Live]: ["live", "live"],
    [ConnectionStatus.Err]: ["err", "error"],
    [ConnectionStatus.Conn]: ["conn", "connecting…"],
  };

  private setDot(s: ConnectionStatus) {
    const { dot, stxt } = this.refs;
    const [cls, txt] = PolymarketCPV.STATUS_DISPLAY[s];
    (dot as HTMLElement).className = `cpv-dot cpv-dot--${cls}`;
    (stxt as HTMLElement).textContent = txt;
  }

  private closeWS() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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
      const suggestions = await fetchSearchSuggestions(query);
      if (!suggestions.length) {
        (this.refs.dropdown as HTMLElement).style.display = "none";
        return;
      }

      const dropdown = this.refs.dropdown as HTMLElement;
      dropdown.innerHTML = "";
      suggestions.forEach((item) => {
        const div = document.createElement("div");
        div.className = "cpv-dropdown-item";
        const vol = item.volume ? parseFloat(item.volume) : 0;
        div.innerHTML = `<span>${item.title}</span><span class="cpv-vol-tag">$${fmtVol(vol)}</span>`;
        div.addEventListener("click", () => {
          this.setDot(ConnectionStatus.Conn);
          this.load(item.slug);
        });
        dropdown.appendChild(div);
      });
      dropdown.style.display = "block";
    }, 250);
  }

  private reqDraw() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw() {
    const state: DrawState = {
      markets: this.markets,
      activeMarkets: this.activeMarkets,
      books: this.books,
      volZoom: this.volZoom,
      mx: this.mx,
      my: this.my,
    };
    const refs = {
      canvas: this.refs.canvas as HTMLCanvasElement,
      overlay: this.refs.overlay as HTMLDivElement,
    };
    draw(state, refs);
  }
}
