import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  scaleAgeStripVolumePerCssPixel,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import { relativeTimeDisplay } from "@/lib/math";
import { bookHoverAtPrice } from "@/lib/bookHover";
import type { TokenBook } from "@/lib/orderBook";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import type { SignedVolumeColorScale } from "@/lib/signedVolume";
import {
  AGE_LABEL_HORIZONTAL_INSET_PX,
  AGE_TIME_GUTTER_PX,
  VOLUME_LEFT_PADDING_PX,
  VOLUME_RIGHT_PADDING_PX,
  ageLabelGutterWidth,
  hasRealOrders,
  measureAgeLabelTextWidth,
  normalizedWheelDelta,
  positionRowControls,
  resolutionOrder,
  resolutionTimestamp,
  sameDisplayTitle,
} from "./ageStripLayout";
import {
  drawAgeAxes,
  drawLivePressureStrip,
} from "./ageStripRendering";
import {
  renderAgeTooltip,
  tooltipSignature,
} from "./ageStripTooltip";
import type { Event } from "@polymarket/client";

interface MarketRuntimeState {
  visibilityInitialized: boolean;
  recordingSinceMs: number | null;
  resolutionMs: number | null;
}

interface HoverRow {
  readonly tokenId: string;
}

interface AnnotationRow {
  readonly tokenId: string;
}

interface HoverGeometry {
  readonly viewport: {
    readonly l: number;
    readonly t: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rows: readonly HoverRow[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

interface HoverPointer {
  readonly sx: number;
  readonly sy: number;
  /** Viewport-space origin of the canvas, derived from the pointer event. */
  readonly canvasLeft: number;
  readonly canvasTop: number;
}

export interface AgeStripHost {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly hiddenTray: HTMLDivElement;
  readonly plotter: OrderBookPlotter;
  readonly activeTokens: Set<string>;
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  readonly getTitle: (marketId: string) => string | undefined;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenName: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
  readonly hideToken: (tokenId: string) => void;
  readonly requestDraw: () => void;
}

/**
 * Age-mode projection of the live order books.
 *
 * Performance benchmark path: render the authoritative live book directly into
 * the visible Canvas2D surface. There is no WebGL texture construction, upload,
 * offscreen presentation, canvas copy, or historical rendering in this branch.
 */
export class AgeStripView {
  private readonly host: AgeStripHost;
  private readonly hiddenTray: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly clockCanvas: HTMLCanvasElement;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly unsubscribeTuning: () => void;
  private readonly markets = new Map<string, MarketRuntimeState>();
  private readonly toggleHomeParent: HTMLElement | null;
  private readonly toggleHomeNextSibling: ChildNode | null;
  private layoutMode: "age" | "volume" | null = null;
  private hoverGeometry: HoverGeometry | null = null;
  private hoverPointer: HoverPointer | null = null;
  private timeLabelTimer: number | undefined;
  private timeLabelRaf: number | undefined;
  private tooltipSignature = "";
  private viewportVisible = true;
  private clockRows: readonly AnnotationRow[] = [];
  private clockGeometry: HoverGeometry | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.toggleHomeParent = host.toggles.parentElement;
    this.toggleHomeNextSibling = host.toggles.nextSibling;

    this.hiddenTray = host.hiddenTray;

    this.clockCanvas = document.createElement("canvas");
    this.clockCanvas.className = "cpv-clock-canvas";
    this.clockCanvas.setAttribute("aria-hidden", "true");
    host.canvasWrap.appendChild(this.clockCanvas);

    // The tooltip is a portal sibling, not a canvas child. Keeping it outside
    // the clipped canvas wrapper makes overflow impossible while preserving the
    // component's inherited theme variables.
    this.overlay = document.createElement("div");
    this.overlay.className = "cpv-overlay";
    this.overlay.setAttribute("role", "tooltip");
    document.body.appendChild(this.overlay);

    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        if (visible === this.viewportVisible) return;
        this.viewportVisible = visible;

        if (!visible) {
          this.cancelTimeLabelRefresh();
          return;
        }

        // Pressure rendering has its own lifecycle. Visibility controls only
        // this independent clock layer.
        this.renderClockLayer();
      },
      // Start work just before the card enters the viewport so scrolling never
      // exposes a stale/blank canvas.
      { root: null, rootMargin: "160px 0px" },
    );
    this.intersectionObserver.observe(host.canvasWrap);

    this.unsubscribeTuning = subscribeAgeStripTuning(() => {
      host.requestDraw();
    });

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
    host.canvas.addEventListener("pointermove", this.handlePointerMove);
    host.canvas.addEventListener("pointerleave", this.handlePointerLeave);
  }

  reset(): void {
    this.cancelTimeLabelRefresh();
    this.markets.clear();
    this.hoverGeometry = null;
    this.clockGeometry = null;
    this.clockRows = [];
    this.hoverPointer = null;
    this.tooltipSignature = "";
    this.clearClockLayer();
    this.hideTooltip();
    this.layoutMode = null;
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    for (const [tokenId, since] of Object.entries(recordingSinceMsByToken)) {
      let state = this.markets.get(tokenId);
      if (!state) {
        state = {
          visibilityInitialized: false,
          recordingSinceMs: null,
          resolutionMs: null,
        };
        this.markets.set(tokenId, state);
      }
      state.recordingSinceMs =
        Number.isFinite(since) && since >= 0 ? since : null;
    }
    if (this.viewportVisible) this.renderClockLayer();
  }

  configureMarkets(event: Event, rawMarkets: readonly unknown[]): void {
    const labels = this.collectControls();
    const marketById = new Map(
      event.markets.map((market) => [String(market.id), market]),
    );
    const rawById = new Map<string, unknown>();
    for (const rawMarket of rawMarkets) {
      const record = asRecord(rawMarket);
      if (record?.id !== undefined)
        rawById.set(String(record.id), rawMarket);
    }
    const orderByToken = resolutionOrder(event, rawMarkets);

    for (const [index, label] of labels.entries()) {
      const marketId = label.dataset.marketId;
      const tokenId = label.dataset.tokenId;
      if (!marketId || !tokenId) continue;

      const market = marketById.get(marketId);
      if (!market) continue;

      label.dataset.marketOrder = String(
        orderByToken.get(tokenId) ?? index,
      );

      const state = this.markets.get(tokenId) ?? {
        visibilityInitialized: false,
        recordingSinceMs: null,
        resolutionMs: null,
      };
      const resolutionMs = resolutionTimestamp(
        rawById.get(marketId),
        market,
      );
      state.resolutionMs = Number.isFinite(resolutionMs)
        ? resolutionMs
        : null;
      this.markets.set(tokenId, state);

      const text =
        this.host.getTitle(marketId) ??
        market.question ??
        "(untitled)";
      const redundantSingleMarketIdentity =
        event.markets.length === 1 &&
        sameDisplayTitle(text, event.title);
      const ageText = redundantSingleMarketIdentity ? "" : text;

      label.dataset.marketLabel = ageText;
      label.dataset.ageLabelWidth = String(
        measureAgeLabelTextWidth(ageText),
      );
      label.dataset.ageSuppressMarketIdentity = String(
        redundantSingleMarketIdentity,
      );
      label.title = text;
    }
  }

  onBookUpdate(tokenId: string): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    let state = this.markets.get(tokenId);
    if (!state) {
      state = {
        visibilityInitialized: false,
        recordingSinceMs: null,
        resolutionMs: null,
      };
      this.markets.set(tokenId, state);
    }

    if (state.visibilityInitialized) return;
    state.visibilityInitialized = true;
    if (hasRealOrders(book)) return;

    if (this.host.activeTokens.has(tokenId))
      this.host.hideToken(tokenId);
  }

  draw(): void {
    this.clockCanvas.style.display = "block";
    const controls = this.collectControls();
    const activeControls = controls.filter((label) => this.isActive(label));
    const rowCount = Math.max(1, activeControls.length);

    this.installAgeLayout(rowCount, activeControls);

    const frame = this.host.plotter.beginFrame(this.host.getTheme(), {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: rowCount - 0.5 },
    });
    positionRowControls(activeControls, frame, rowCount);

    const vp = frame.viewport;
    this.hoverGeometry = {
      viewport: { l: vp.l, t: vp.t, width: vp.width, height: vp.height },
      rows: activeControls.map((label, index) => ({
        tokenId: label.dataset.tokenId ?? `missing-row-${index}`,
      })),
      canvasWidth: vp.l + vp.width + this.host.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.host.plotter.padding.b,
    };

    this.clockGeometry = this.hoverGeometry;
    this.clockRows = activeControls.map((label, index) => ({
      tokenId: label.dataset.tokenId ?? `missing-row-${index}`,
    }));
    if (this.viewportVisible) this.renderClockLayer();

    for (const [index, label] of activeControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;
      const book = this.host.getBook(tokenId);
      if (!book) continue;

      const y = rowCount - 1 - index;
      drawLivePressureStrip(
        frame,
        y,
        book,
        this.host.getPressureColorScale(tokenId),
        getAgeStripTuning().volumePerCssPixel,
      );
    }

    drawAgeAxes(
      frame,
      rowCount,
      activeControls,
      (tokenId) => this.host.getPressureColorScale(tokenId),
    );
    if (this.hoverPointer) this.renderHoverTooltip(this.hoverPointer);
  }

  prepareVolumeView(): void {
    this.cancelTimeLabelRefresh();
    this.hoverGeometry = null;
    this.clockGeometry = null;
    this.clockRows = [];
    this.clearClockLayer();
    this.clockCanvas.style.display = "none";
    this.hoverPointer = null;
    this.hideTooltip();
    if (this.layoutMode === "volume") return;

    for (const label of this.collectControls())
      if (label.style.top !== "") label.style.top = "";

    let resize = false;
    if (this.host.plotter.padding.l !== VOLUME_LEFT_PADDING_PX) {
      this.host.plotter.padding.l = VOLUME_LEFT_PADDING_PX;
      resize = true;
    }
    if (this.host.plotter.padding.r !== VOLUME_RIGHT_PADDING_PX) {
      this.host.plotter.padding.r = VOLUME_RIGHT_PADDING_PX;
      resize = true;
    }
    if (this.host.canvasWrap.style.height !== "") {
      this.host.canvasWrap.style.height = "";
      resize = true;
    }

    this.host.toggles.classList.remove("cpv-toggles--age-axis");
    if (this.host.toggles.style.width !== "") this.host.toggles.style.width = "";

    if (
      this.toggleHomeParent &&
      this.host.toggles.parentElement !== this.toggleHomeParent
    ) {
      if (this.toggleHomeNextSibling?.parentNode === this.toggleHomeParent)
        this.toggleHomeParent.insertBefore(
          this.host.toggles,
          this.toggleHomeNextSibling,
        );
      else this.toggleHomeParent.appendChild(this.host.toggles);
    }

    if (resize) this.host.plotter.resize();
    this.layoutMode = "volume";
  }

  destroy(): void {
    this.cancelTimeLabelRefresh();
    this.intersectionObserver.disconnect();
    this.unsubscribeTuning();
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.host.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.host.canvas.removeEventListener("pointerleave", this.handlePointerLeave);
    this.hideTooltip();
    this.overlay.remove();
    this.clockCanvas.remove();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.hoverPointer = {
      sx: event.offsetX,
      sy: event.offsetY,
      canvasLeft: event.clientX - event.offsetX,
      canvasTop: event.clientY - event.offsetY,
    };
    this.renderHoverTooltip(this.hoverPointer);
  };

  private readonly handlePointerLeave = () => {
    this.hoverPointer = null;
    this.hideTooltip();
  };

  private renderHoverTooltip(pointer: HoverPointer): void {
    const { sx, sy } = pointer;
    if (this.host.getViewMode() !== "age") {
      this.hideTooltip();
      return;
    }

    const geometry = this.hoverGeometry;
    if (!geometry || geometry.rows.length === 0) {
      this.hideTooltip();
      return;
    }

    const { viewport: vp } = geometry;
    if (
      sx < vp.l ||
      sx > vp.l + vp.width ||
      sy < vp.t ||
      sy >= vp.t + vp.height
    ) {
      this.hideTooltip();
      return;
    }

    const rowIndex = Math.floor(((sy - vp.t) / vp.height) * geometry.rows.length);
    const row = geometry.rows[rowIndex];
    if (!row) {
      this.hideTooltip();
      return;
    }

    const book = this.host.getBook(row.tokenId);
    if (!book) {
      this.hideTooltip();
      return;
    }

    // Age view is intentionally mirrored so the opposite token is on the
    // left and the primary token is on the right. Convert display-x back to
    // the canonical primary-token price before querying the book.
    const displayPrice = (sx - vp.l) / vp.width;
    const hover = bookHoverAtPrice(book, 1 - displayPrice);
    if (hover.side === "spread") {
      this.hideTooltip();
      return;
    }

    const tokenName =
      hover.side === "bid"
        ? this.host.getTokenName(row.tokenId)
        : this.host.getOppositeTokenName(row.tokenId);
    const resolvedName = tokenName ?? "(unknown)";
    const signature = tooltipSignature(resolvedName, hover);
    if (signature !== this.tooltipSignature) {
      renderAgeTooltip(
        this.overlay,
        resolvedName,
        hover,
        this.host.getPressureColorScale(row.tokenId),
      );
      this.tooltipSignature = signature;
    }

    // Anchor the portal at mouse-x / row-center-y in viewport space. Both
    // canvas origin coordinates come from the pointer event itself, so this
    // remains free of getBoundingClientRect()/offsetWidth layout reads.
    const anchorX = pointer.canvasLeft + sx;
    const rowCenterY =
      pointer.canvasTop +
      vp.t +
      ((rowIndex + 0.5) / geometry.rows.length) * vp.height;

    this.overlay.style.display = "block";
    this.overlay.style.left = `${anchorX}px`;
    this.overlay.style.top = `${rowCenterY}px`;
    this.overlay.style.transform =
      `${anchorX > window.innerWidth / 2
        ? "translateX(calc(-100% - 12px))"
        : "translateX(12px)"} ${rowCenterY > window.innerHeight / 2
          ? "translateY(calc(-100% - 12px))"
          : "translateY(12px)"}`;
  }

  private readonly hideTooltip = () => {
    this.overlay.style.display = "none";
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.host.getViewMode() !== "age" || !event.ctrlKey) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factor = Math.exp(normalizedWheelDelta(event) * 0.002);
    scaleAgeStripVolumePerCssPixel(factor);
  };

  private installAgeLayout(
    rowCount: number,
    labels: readonly HTMLLabelElement[],
  ): void {
    const leftPadding = AGE_TIME_GUTTER_PX;
    const rightPadding = ageLabelGutterWidth(labels);
    let resize = false;
    if (this.host.plotter.padding.l !== leftPadding) {
      this.host.plotter.padding.l = leftPadding;
      resize = true;
    }
    if (this.host.plotter.padding.r !== rightPadding) {
      this.host.plotter.padding.r = rightPadding;
      resize = true;
    }

    const height =
      this.host.plotter.padding.t +
      this.host.plotter.padding.b +
      rowCount * AGE_ROW_BAND_PX;
    const heightCss = `${height}px`;
    if (this.host.canvasWrap.style.height !== heightCss) {
      this.host.canvasWrap.style.height = heightCss;
      resize = true;
    }

    if (this.host.toggles.parentElement !== this.host.canvasWrap) {
      this.host.canvasWrap.appendChild(this.host.toggles);
      resize = true;
    }
    this.host.toggles.classList.add("cpv-toggles--age-axis");
    const widthCss = `${rightPadding}px`;
    if (this.host.toggles.style.width !== widthCss)
      this.host.toggles.style.width = widthCss;

    if (resize) this.host.plotter.resize();
    this.layoutMode = "age";
  }

  private collectControls(): HTMLLabelElement[] {
    return [
      ...this.host.toggles.querySelectorAll<HTMLLabelElement>(
        "label[data-token-id]",
      ),
      ...this.hiddenTray.querySelectorAll<HTMLLabelElement>(
        "label[data-token-id]",
      ),
    ].sort(
      (a, b) =>
        Number(a.dataset.marketOrder ?? 0) - Number(b.dataset.marketOrder ?? 0),
    );
  }

  private isActive(label: HTMLLabelElement): boolean {
    const tokenId = label.dataset.tokenId;
    return !!tokenId && this.host.activeTokens.has(tokenId);
  }

  private renderClockLayer(): void {
    this.cancelTimeLabelRefresh();

    const geometry = this.clockGeometry;
    if (
      !geometry ||
      this.clockRows.length === 0 ||
      !this.viewportVisible ||
      this.host.getViewMode() !== "age"
    )
      return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(geometry.canvasWidth * dpr));
    const height = Math.max(1, Math.round(geometry.canvasHeight * dpr));
    if (this.clockCanvas.width !== width) this.clockCanvas.width = width;
    if (this.clockCanvas.height !== height) this.clockCanvas.height = height;

    const ctx = this.clockCanvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.host.getTheme().text;

    const nowMs = Date.now();
    const { viewport: vp } = geometry;
    const rowCount = this.clockRows.length;
    const timeX = Math.max(4, vp.l - AGE_LABEL_HORIZONTAL_INSET_PX);
    let nextChangeMs = Infinity;

    for (const [rowIndex, row] of this.clockRows.entries()) {
      const state = this.markets.get(row.tokenId);
      const rowCenterY =
        vp.t + ((rowIndex + 0.5) / rowCount) * vp.height;

      if (!state) continue;

      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";

      const since = state.recordingSinceMs;
      if (since !== null && Number.isFinite(since)) {
        const display = relativeTimeDisplay(
          Math.max(0, nowMs - since) / 1000,
          "elapsed",
        );
        ctx.globalAlpha = 0.55;
        ctx.fillText(display.text, timeX, rowCenterY - 5);
        if (display.nextChangeMs !== null)
          nextChangeMs = Math.min(nextChangeMs, display.nextChangeMs);
      }

      const resolutionMs = state.resolutionMs;
      if (resolutionMs !== null && Number.isFinite(resolutionMs)) {
        const display = relativeTimeDisplay(
          Math.max(0, resolutionMs - nowMs) / 1000,
          "remaining",
        );
        ctx.globalAlpha = 0.82;
        ctx.fillText(
          display.text === "due" ? "due" : `T−${display.text}`,
          timeX,
          rowCenterY + 5,
        );
        if (display.nextChangeMs !== null)
          nextChangeMs = Math.min(nextChangeMs, display.nextChangeMs);
      }
    }

    ctx.globalAlpha = 1;
    if (Number.isFinite(nextChangeMs))
      this.scheduleTimeLabelRefresh(nextChangeMs);
  }

  private clearClockLayer(): void {
    const ctx = this.clockCanvas.getContext?.("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.clockCanvas.width, this.clockCanvas.height);
  }

  private scheduleTimeLabelRefresh(delayMs: number): void {
    // Millisecond labels are visually meaningful, but a 1ms timeout is not.
    // Coalesce very near deadlines into the next paint.
    if (delayMs <= 34) {
      this.timeLabelRaf = requestAnimationFrame(() => {
        this.timeLabelRaf = undefined;
        if (!this.viewportVisible || this.host.getViewMode() !== "age") return;
        this.renderClockLayer();
      });
      return;
    }

    this.timeLabelTimer = window.setTimeout(() => {
      this.timeLabelTimer = undefined;
      if (!this.viewportVisible || this.host.getViewMode() !== "age") return;
      this.renderClockLayer();
    }, Math.max(1, Math.ceil(delayMs) + 1));
  }

  private cancelTimeLabelRefresh(): void {
    if (this.timeLabelTimer !== undefined) {
      clearTimeout(this.timeLabelTimer);
      this.timeLabelTimer = undefined;
    }
    if (this.timeLabelRaf !== undefined) {
      cancelAnimationFrame(this.timeLabelRaf);
      this.timeLabelRaf = undefined;
    }
  }


}
