import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  scaleAgeStripVolumePerCssPixel,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import { relativeTimeDisplay } from "@/lib/math";
import { bookHoverAtPrice, type BookHoverSnapshot } from "@/lib/bookHover";
import { pressureInkThicknessCss } from "@/lib/pressureInk";
import type { TokenBook } from "@/lib/orderBook";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import {
  signedVolumeColor,
  signedVolumeSegments,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import type { Event } from "@polymarket/client";

const AGE_LABEL_MIN_GUTTER_PX = 16;
const AGE_LABEL_MAX_GUTTER_PX = 100;
const AGE_LABEL_HORIZONTAL_INSET_PX = 8;
const AGE_TIME_META_WIDTH_PX = 52;
const AGE_MARKET_ICON_SIZE_PX = 16;
const AGE_MARKET_ICON_GAP_PX = 8;
const AGE_TIME_GUTTER_PX =
  AGE_TIME_META_WIDTH_PX + AGE_LABEL_HORIZONTAL_INSET_PX * 2 + 1;
const VOLUME_LEFT_PADDING_PX = 60;
const VOLUME_RIGHT_PADDING_PX = 16;
const HIDDEN_MARKETS_STORAGE_KEY = "polymarket-book-vis.age-strip-hidden-markets.v1";

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
  readonly plotter: OrderBookPlotter;
  readonly activeTokens: Set<string>;
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  readonly getTitle: (marketId: string) => string | undefined;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenName: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
  readonly requestDraw: () => void;
}

const userHiddenMarketIds = loadStringSet(HIDDEN_MARKETS_STORAGE_KEY);

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

    this.hiddenTray = document.createElement("div");
    this.hiddenTray.className = "cpv-hidden-markets";
    this.hiddenTray.hidden = true;
    host.canvasWrap.insertAdjacentElement("afterend", this.hiddenTray);

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
    this.hiddenTray.replaceChildren();
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
    const activeMarkets = event.markets.filter((market) => {
      const tokenId = market.outcomes.yes.tokenId;
      return tokenId !== null && this.host.activeTokens.has(tokenId);
    });
    const labels = Array.from(
      this.host.toggles.querySelectorAll<HTMLLabelElement>("label"),
    );
    const rawById = new Map<string, unknown>();
    for (const rawMarket of rawMarkets) {
      const record = asRecord(rawMarket);
      if (typeof record?.id === "string") rawById.set(record.id, rawMarket);
    }
    const orderByToken = resolutionOrder(event, rawMarkets);

    for (const [index, label] of labels.entries()) {
      const market = activeMarkets[index];
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      label.dataset.tokenId = tokenId;
      label.dataset.marketId = market.id;
      label.dataset.marketOrder = String(orderByToken.get(tokenId) ?? index);

      const state = this.markets.get(tokenId) ?? {
        visibilityInitialized: false,
        recordingSinceMs: null,
        resolutionMs: null,
      };
      const resolutionMs = resolutionTimestamp(
        rawById.get(market.id),
        market,
      );
      state.resolutionMs = Number.isFinite(resolutionMs) ? resolutionMs : null;
      this.markets.set(tokenId, state);

      const text =
        this.host.getTitle(market.id) ??
        market.question ??
        "(untitled)";
      const redundantSingleMarketIdentity =
        event.markets.length === 1 && sameDisplayTitle(text, event.title);
      const ageText = redundantSingleMarketIdentity ? "" : text;

      const textSpan =
        label.querySelector<HTMLSpanElement>(".cpv-market-label-text");
      if (textSpan && textSpan.textContent !== text)
        textSpan.textContent = text;

      label.dataset.marketLabel = ageText;
      label.dataset.ageLabelWidth = String(measureAgeLabelTextWidth(ageText));
      label.dataset.ageSuppressMarketIdentity = String(
        redundantSingleMarketIdentity,
      );
      label.title = text;

      const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (!checkbox) continue;

      if (
        market.state.acceptingOrders !== true ||
        userHiddenMarketIds.has(market.id)
      ) {
        checkbox.checked = false;
        this.host.activeTokens.delete(tokenId);
      }

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.host.activeTokens.add(tokenId);
          userHiddenMarketIds.delete(market.id);
        } else {
          this.host.activeTokens.delete(tokenId);
          userHiddenMarketIds.add(market.id);
        }
        persistStringSet(HIDDEN_MARKETS_STORAGE_KEY, userHiddenMarketIds);
        this.host.requestDraw();
      });
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

    const label = this.findControl(tokenId);
    const marketId = label?.dataset.marketId;
    if (!label || !marketId || userHiddenMarketIds.has(marketId)) return;

    const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!checkbox) return;
    checkbox.checked = false;
    this.host.activeTokens.delete(tokenId);
  }

  draw(): void {
    this.clockCanvas.style.display = "block";
    const controls = this.collectControls();
    this.syncControlPlacement(controls);
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

    const controls = this.collectControls();
    for (const label of controls) {
      if (label.style.top !== "") label.style.top = "";
      this.host.toggles.appendChild(label);
    }
    if (!this.hiddenTray.hidden) this.hiddenTray.hidden = true;

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
    this.hiddenTray.remove();
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

  private syncControlPlacement(labels: readonly HTMLLabelElement[]): void {
    let hiddenCount = 0;
    for (const label of labels) {
      const active = this.isActive(label);
      const parent = active ? this.host.toggles : this.hiddenTray;
      if (label.parentElement !== parent) parent.appendChild(label);

      if (!active) {
        if (label.style.top !== "") label.style.top = "";
        hiddenCount++;
      }
    }

    const shouldHideTray = hiddenCount === 0;
    if (this.hiddenTray.hidden !== shouldHideTray)
      this.hiddenTray.hidden = shouldHideTray;
  }

  private findControl(tokenId: string): HTMLLabelElement | undefined {
    return this.collectControls().find(
      (label) => label.dataset.tokenId === tokenId,
    );
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

function ageLabelGutterWidth(labels: readonly HTMLLabelElement[]): number {
  if (labels.length === 0) return AGE_LABEL_MIN_GUTTER_PX;

  const iconExtra = labels.some(
    (label) =>
      label.dataset.ageSuppressMarketIdentity !== "true" &&
      label.querySelector(".cpv-market-icon") !== null,
  )
    ? AGE_MARKET_ICON_SIZE_PX + AGE_MARKET_ICON_GAP_PX
    : 0;

  let widest = 0;
  for (const label of labels) {
    const cached = Number(label.dataset.ageLabelWidth);
    if (!Number.isFinite(cached)) continue;
    widest = Math.max(widest, cached);
  }

  return Math.ceil(
    clamp(
      widest +
      iconExtra +
      AGE_LABEL_HORIZONTAL_INSET_PX * 2 +
      1,
      AGE_LABEL_MIN_GUTTER_PX,
      AGE_LABEL_MAX_GUTTER_PX,
    ),
  );
}

let ageLabelMeasureCtx: CanvasRenderingContext2D | null | undefined;

function getAgeLabelMeasureContext(): CanvasRenderingContext2D | null {
  if (ageLabelMeasureCtx !== undefined) return ageLabelMeasureCtx;
  const canvas = document.createElement("canvas");
  ageLabelMeasureCtx =
    typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  return ageLabelMeasureCtx;
}

function measureAgeLabelTextWidth(text: string): number {
  const ctx = getAgeLabelMeasureContext();
  if (!ctx) return text.length * 6;
  ctx.font = "11px sans-serif";
  return ctx.measureText(text).width;
}

function sameDisplayTitle(a: string, b: string | null | undefined): boolean {
  if (!b) return false;
  return normalizeDisplayTitle(a) === normalizeDisplayTitle(b);
}

function normalizeDisplayTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function ellipsizeCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (!(maxWidth > 0)) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "…";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth >= maxWidth) return ellipsis;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

function tooltipSignature(
  tokenName: string,
  hover: BookHoverSnapshot,
): string {
  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? ""
      : formatProbability(
        isBid ? hover.effectivePrice : 1 - hover.effectivePrice,
      );
  return [
    tokenName,
    hover.side,
    formatProbability(tokenPrice),
    formatShares(hover.shares),
    effectivePrice,
  ].join("|");
}

function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  hover: BookHoverSnapshot,
  colorScale: SignedVolumeColorScale,
): void {
  overlay.replaceChildren();

  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? null
      : isBid
        ? hover.effectivePrice
        : 1 - hover.effectivePrice;

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent = `${tokenName}@${formatProbability(tokenPrice)}`;
  title.style.color = signedVolumeColor(isBid ? 1 : -1, colorScale);
  overlay.appendChild(title);
  overlay.appendChild(tooltipRow("Shares", formatShares(hover.shares)));
  if (effectivePrice !== null)
    overlay.appendChild(
      tooltipRow("Effective", formatProbability(effectivePrice)),
    );
}

function tooltipRow(name: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cpv-ov-row";
  const key = document.createElement("span");
  key.textContent = name;
  const amount = document.createElement("b");
  amount.textContent = value;
  row.append(key, amount);
  return row;
}

function formatProbability(value: number): string {
  return value.toFixed(3);
}

function formatShares(value: number): string {
  if (!(value > 0)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function positionRowControls(
  labels: readonly HTMLLabelElement[],
  frame: any,
  rowCount: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  for (const [index, label] of labels.entries()) {
    const y = rowCount - 1 - index;
    const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
    const top = `${geometry.centerCss}px`;
    if (label.style.top !== top) label.style.top = top;
  }
}

/** Draw per-row probability rails using each market's semantic token colors. */
function drawAgeAxes(
  frame: any,
  rowCount: number,
  labels: readonly HTMLLabelElement[],
  colorScaleForToken: (tokenId: string) => SignedVolumeColorScale,
): void {
  const { ctx, viewport: vp, theme } = frame;
  const dpr = window.devicePixelRatio || 1;

  ctx.lineWidth = 1;
  for (const [index, label] of labels.entries()) {
    const tokenId = label.dataset.tokenId;
    if (!tokenId) continue;

    const y = rowCount - 1 - index;
    const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
    const scale = colorScaleForToken(tokenId);

    // Mirrored token orientation: opposite on the left, primary on the right.
    ctx.strokeStyle = signedVolumeColor(-1, scale);
    ctx.beginPath();
    ctx.moveTo(vp.l, geometry.topCss);
    ctx.lineTo(vp.l, geometry.topCss + geometry.heightCss);
    ctx.stroke();

    ctx.strokeStyle = signedVolumeColor(1, scale);
    ctx.beginPath();
    ctx.moveTo(vp.l + vp.width, geometry.topCss);
    ctx.lineTo(vp.l + vp.width, geometry.topCss + geometry.heightCss);
    ctx.stroke();
  }

  ctx.fillStyle = theme.text;
  if (ctx.font !== "11px sans-serif") ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0", vp.l, vp.t + vp.height + 8);
  ctx.fillText("1", vp.l + vp.width, vp.t + vp.height + 8);

  ctx.beginPath();
  ctx.rect(vp.l, vp.t, vp.width, vp.height);
  ctx.clip();
}

function drawLivePressureStrip(
  frame: any,
  y: number,
  book: TokenBook<string>,
  colorScale: SignedVolumeColorScale,
  volumePerCssPixel: number,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
  const reserveShares = volumePerCssPixel * geometry.heightCss;

  ctx.save();
  ctx.beginPath();
  ctx.rect(vp.l, geometry.topCss, vp.width, geometry.heightCss);
  ctx.clip();

  for (const segment of signedVolumeSegments(book)) {
    if (segment.volume === 0 || Number.isNaN(segment.volume)) continue;

    // signedVolumeSegments is expressed in canonical primary-token price.
    // Mirror it for the age view so opposite liquidity is left and primary
    // liquidity is right, matching the row identity placement.
    const displayLo = 1 - clamp(segment.hi, 0, 1);
    const displayHi = 1 - clamp(segment.lo, 0, 1);
    const x0 = snapToDevicePixel(
      vp.l + displayLo * vp.width,
      dpr,
    );
    const x1 = snapToDevicePixel(
      vp.l + displayHi * vp.width,
      dpr,
    );
    if (!(x1 > x0)) continue;

    const thickness = pressureInkThicknessCss(
      segment.volume,
      reserveShares,
      geometry.heightCss,
    );
    if (!(thickness > 0)) continue;

    ctx.fillStyle = signedVolumeColor(segment.volume, colorScale);
    ctx.fillRect(
      x0,
      geometry.centerCss - thickness / 2,
      x1 - x0,
      thickness,
    );
  }

  ctx.restore();
}

function rowRasterGeometry(
  desiredCenterCss: number,
  dpr: number,
): {
  deviceHeight: number;
  topCss: number;
  heightCss: number;
  centerCss: number;
} {
  const deviceHeight = Math.max(1, Math.round(AGE_ROW_BAND_PX * dpr));
  const topDevice = Math.round(desiredCenterCss * dpr - deviceHeight / 2);
  const topCss = topDevice / dpr;
  const heightCss = deviceHeight / dpr;
  return {
    deviceHeight,
    topCss,
    heightCss,
    centerCss: topCss + heightCss / 2,
  };
}

function hasRealOrders(book: TokenBook<string>): boolean {
  // yesToUsd always includes the synthetic mint level.
  return book.usdToYes.size > 0 || book.yesToUsd.size > 1;
}

function resolutionOrder(
  event: Event,
  rawMarkets: readonly unknown[],
): Map<string, number> {
  const rawById = new Map<string, unknown>();
  for (const rawMarket of rawMarkets) {
    const record = asRecord(rawMarket);
    if (typeof record?.id === "string") rawById.set(record.id, rawMarket);
  }

  const sorted = event.markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionTimestamp(rawById.get(market.id), market),
    }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.timestamp);
      const bKnown = Number.isFinite(b.timestamp);
      if (aKnown && bKnown)
        return a.timestamp - b.timestamp || a.originalIndex - b.originalIndex;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const order = new Map<string, number>();
  for (const [index, { market }] of sorted.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) order.set(tokenId, index);
  }
  return order;
}

function resolutionTimestamp(...sources: readonly unknown[]): number {
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;
    const state = asRecord(record.state);
    for (const candidate of [
      state?.endDate,
      state?.end_date,
      record.endDate,
      record.endDateIso,
      record.end_date,
      record.end_date_iso,
    ]) {
      if (candidate instanceof Date) return candidate.getTime();
      if (typeof candidate === "number" && Number.isFinite(candidate))
        return candidate;
      if (typeof candidate === "string") {
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return Infinity;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function loadStringSet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistStringSet(key: string, values: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // Preferences are best effort.
  }
}

function normalizedWheelDelta(event: WheelEvent): number {
  let delta = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 400;
  return clamp(delta, -500, 500);
}

function snapToDevicePixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
