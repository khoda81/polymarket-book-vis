import type { RecordedAgeState } from "@/lib/ageRecorderClient";
import { fmtRelativeTime } from "@/lib/math";
import { bookHoverAtPrice, type BookHoverSnapshot } from "@/lib/bookHover";
import {
  DEFAULT_VOLUME_PER_CSS_PIXEL,
  pressureInkProfile,
} from "@/lib/pressureInk";
import type { TokenBook } from "@/lib/orderBook";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "@/lib/signedVolume";
import {
  StaleSignedVolume,
  type PressureObservationRange,
  type StaleSignedVolumeSegment,
} from "@/lib/staleSignedVolume";
import {
  sharedWebGLPressureRenderer,
  type WebGLPressureRow,
} from "@/lib/webglPressure";
import type { Event } from "@polymarket/client";

const AGE_LABEL_MIN_GUTTER_PX = 44;
const AGE_LABEL_MAX_GUTTER_PX = 180;
const AGE_LABEL_HORIZONTAL_INSET_PX = 8;
const AGE_RECORDING_AGE_WIDTH_PX = 44;
const AGE_LABEL_GAP_PX = 6;
const VOLUME_LEFT_PADDING_PX = 60;
export const AGE_ROW_BAND_PX = 36;

const MIN_AGE_SCALE_SECONDS = 0.05;
const MAX_AGE_SCALE_SECONDS = 7 * 24 * 60 * 60;
const MIN_VOLUME_PER_CSS_PIXEL = 1;
const MAX_VOLUME_PER_CSS_PIXEL = 1e9;

const TUNING_STORAGE_KEY = "polymarket-book-vis.age-strip-tuning.v1";
const HIDDEN_MARKETS_STORAGE_KEY =
  "polymarket-book-vis.age-strip-hidden-markets.v1";

export interface AgeStripTuning {
  ageScaleSeconds: number;
  /** Fully opaque CSS-pixel-equivalent represented by this many YES. */
  volumePerCssPixel: number;
}

interface StoredAgeStripTuning {
  ageScaleSeconds?: number;
  volumePerCssPixel?: number;
  /** Legacy v1 name; migrated in place to volumePerCssPixel. */
  volumeSoftLimit?: number;
}

interface MarketRuntimeState {
  readonly field: StaleSignedVolume;
  visibilityInitialized: boolean;
  recordingSinceMs: number | null;
}

interface HoverRow {
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
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
  readonly requestDraw: () => void;
}

const tuning = loadTuning();
const userHiddenMarketIds = loadStringSet(HIDDEN_MARKETS_STORAGE_KEY);
const redrawCallbacks = new Set<() => void>();
const tuningListeners = new Set<(tuning: Readonly<AgeStripTuning>) => void>();
let tuningPersistTimer: number | undefined;
let globalRedrawRaf: number | undefined;

export function getAgeStripTuning(): Readonly<AgeStripTuning> {
  return { ...tuning };
}

export function subscribeAgeStripTuning(
  listener: (tuning: Readonly<AgeStripTuning>) => void,
): () => void {
  tuningListeners.add(listener);
  return () => tuningListeners.delete(listener);
}

/**
 * Age-mode projection of the live order books.
 *
 * The WebGL path renders the authoritative live book sharply and keeps time in
 * a separate diffusing resin texture. CPU sample-and-hold segments are retained
 * as rebuild/hydration history and as the reliable Canvas2D fallback.
 */
export class AgeStripView {
  private readonly host: AgeStripHost;
  private readonly hiddenTray: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly markets = new Map<string, MarketRuntimeState>();
  private readonly toggleHomeParent: HTMLElement | null;
  private readonly toggleHomeNextSibling: ChildNode | null;
  private readonly gpuKey = {};
  private readonly dirtyTokens = new Set<string>();

  private diffusionTimer: number | undefined;
  private layoutMode: "age" | "volume" | null = null;
  private hoverGeometry: HoverGeometry | null = null;
  private lastRecordingAgeLabelUpdateMs = 0;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.toggleHomeParent = host.toggles.parentElement;
    this.toggleHomeNextSibling = host.toggles.nextSibling;

    this.hiddenTray = document.createElement("div");
    this.hiddenTray.className = "cpv-hidden-markets";
    this.hiddenTray.hidden = true;
    host.canvasWrap.insertAdjacentElement("afterend", this.hiddenTray);

    const existingOverlay = host.canvasWrap.querySelector<HTMLDivElement>(".cpv-overlay");
    if (existingOverlay) this.overlay = existingOverlay;
    else {
      this.overlay = document.createElement("div");
      this.overlay.className = "cpv-overlay";
      host.canvasWrap.appendChild(this.overlay);
    }

    redrawCallbacks.add(host.requestDraw);

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
    host.canvas.addEventListener("pointermove", this.handlePointerMove);
    host.canvas.addEventListener("pointerleave", this.hideTooltip);
  }

  reset(): void {
    this.cancelDiffusionTimer();
    sharedWebGLPressureRenderer.release(this.gpuKey);
    this.dirtyTokens.clear();
    this.markets.clear();
    this.hiddenTray.replaceChildren();
    this.hoverGeometry = null;
    this.hideTooltip();
    this.layoutMode = null;
  }

  /** Seed sample-and-hold fields recorded by the always-on backend. */
  hydrate(
    states: Readonly<Record<string, RecordedAgeState>>,
    recordingSinceMsByToken: Readonly<Record<string, number>> = {},
  ): void {
    sharedWebGLPressureRenderer.release(this.gpuKey);
    this.dirtyTokens.clear();
    const nowMs = performance.now();

    for (const tokenId of new Set([
      ...Object.keys(states),
      ...Object.keys(recordingSinceMsByToken),
    ])) {
      const field = new StaleSignedVolume();
      const recorded = states[tokenId];
      if (recorded) field.restoreSegments(recorded.segments, nowMs);
      const since = recordingSinceMsByToken[tokenId];
      this.markets.set(tokenId, {
        field,
        visibilityInitialized: false,
        recordingSinceMs:
          typeof since === "number" && Number.isFinite(since) ? since : null,
      });
    }

    this.refreshRecordingAgeLabels(true);
  }

  configureMarkets(event: Event, rawMarkets: readonly unknown[]): void {
    const activeMarkets = event.markets.filter((market) => {
      const tokenId = market.outcomes.yes.tokenId;
      return tokenId !== null && this.host.activeTokens.has(tokenId);
    });
    const labels = Array.from(
      this.host.toggles.querySelectorAll<HTMLLabelElement>("label"),
    );
    const orderByToken = resolutionOrder(event, rawMarkets);

    for (const [index, label] of labels.entries()) {
      const market = activeMarkets[index];
      const tokenId = market?.outcomes.yes.tokenId;
      if (!market || !tokenId) continue;

      label.dataset.tokenId = tokenId;
      label.dataset.marketId = market.id;
      label.dataset.marketOrder = String(orderByToken.get(tokenId) ?? index);

      const dot = label.querySelector<HTMLSpanElement>("span");
      dot?.classList.add("cpv-market-dot");

      for (const node of Array.from(label.childNodes))
        if (node.nodeType === Node.TEXT_NODE) node.remove();

      const text =
        this.host.getTitle(market.id) ??
        market.question ??
        "(untitled)";
      const textSpan = document.createElement("span");
      textSpan.className = "cpv-market-label-text";
      textSpan.textContent = text;
      label.appendChild(textSpan);
      label.dataset.ageLabelWidth = String(measureIntrinsicTextWidth(textSpan));

      const recordingAge = document.createElement("span");
      recordingAge.className = "cpv-recording-age";
      recordingAge.hidden = true;
      label.appendChild(recordingAge);
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
        if (this.host.activeTokens.has(tokenId))
          userHiddenMarketIds.delete(market.id);
        else userHiddenMarketIds.add(market.id);
        persistStringSet(HIDDEN_MARKETS_STORAGE_KEY, userHiddenMarketIds);
      });
    }
  }

  onBookUpdate(
    tokenId: string,
    nowMs: number,
    observedRanges?: readonly PressureObservationRange[],
  ): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    let state = this.markets.get(tokenId);
    if (!state) {
      state = {
        field: new StaleSignedVolume(),
        visibilityInitialized: false,
        recordingSinceMs: null,
      };
      this.markets.set(tokenId, state);
    }

    state.field.update(book, nowMs, observedRanges);
    this.dirtyTokens.add(tokenId);

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
    this.cancelDiffusionTimer();
    this.refreshRecordingAgeLabels();

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

    const nowMs = performance.now();
    const colorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE;
    const rows: WebGLPressureRow[] = activeControls.map((label, index) => {
      const tokenId = label.dataset.tokenId ?? `missing-row-${index}`;
      return {
        tokenId,
        segments: this.markets.get(tokenId)?.field.segments(nowMs) ?? [],
      };
    });

    const gpuCanvas = sharedWebGLPressureRenderer.render({
      key: this.gpuKey,
      rows,
      dirtyTokens: this.dirtyTokens,
      getBook: this.host.getBook,
      widthCss: vp.width,
      heightCss: vp.height,
      dpr: window.devicePixelRatio || 1,
      nowMs,
      ageScaleSeconds: tuning.ageScaleSeconds,
      volumePerCssPixel: tuning.volumePerCssPixel,
      colorScale,
      requestRedraw: this.host.requestDraw,
    });

    if (gpuCanvas) {
      const { ctx } = frame;
      ctx.save();
      ctx.beginPath();
      ctx.rect(vp.l, vp.t, vp.width, vp.height);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(gpuCanvas, vp.l, vp.t, vp.width, vp.height);
      ctx.restore();
      drawAgeAxes(frame);
      this.dirtyTokens.clear();
      if (sharedWebGLPressureRenderer.hasHistory(this.gpuKey))
        this.scheduleDiffusionTimer(gpuDiffusionDelayMs(tuning.ageScaleSeconds));
      return;
    }

    // Reliable reference/fallback path: reconstruct the legacy vertical
    // sample-and-hold profiles directly in Canvas2D.
    let hasDiffusingPressure = false;
    for (const [index, row] of rows.entries()) {
      if (row.segments.length === 0) continue;
      const y = rowCount - 1 - index;
      drawPressureStrip(
        frame,
        y,
        row.segments,
        colorScale,
        tuning.volumePerCssPixel,
        tuning.ageScaleSeconds,
      );
      hasDiffusingPressure ||= row.segments.some(
        (segment) => segment.volume !== 0 && segment.ageMs !== Infinity,
      );
    }
    drawAgeAxes(frame);
    this.dirtyTokens.clear();
    if (hasDiffusingPressure)
      this.scheduleDiffusionTimer(gpuDiffusionDelayMs(tuning.ageScaleSeconds));
  }

  prepareVolumeView(): void {
    this.cancelDiffusionTimer();
    this.hoverGeometry = null;
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
    this.cancelDiffusionTimer();
    sharedWebGLPressureRenderer.release(this.gpuKey);
    redrawCallbacks.delete(this.host.requestDraw);
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.host.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.host.canvas.removeEventListener("pointerleave", this.hideTooltip);
    this.hideTooltip();
    this.hiddenTray.remove();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (this.host.getViewMode() !== "age") {
      this.hideTooltip();
      return;
    }

    const geometry = this.hoverGeometry;
    if (!geometry || geometry.rows.length === 0) {
      this.hideTooltip();
      return;
    }

    const sx = event.offsetX;
    const sy = event.offsetY;
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

    const hover = bookHoverAtPrice(book, (sx - vp.l) / vp.width);
    if (hover.side === "spread") {
      this.hideTooltip();
      return;
    }

    const tokenName =
      hover.side === "bid"
        ? this.host.getTokenName(row.tokenId)
        : this.host.getOppositeTokenName(row.tokenId);
    renderAgeTooltip(
      this.overlay,
      tokenName ?? "(unknown)",
      hover,
    );

    const tooltipWidth = 180;
    const tooltipHeight = 82;
    const rowCenterY =
      vp.t + ((rowIndex + 0.5) / geometry.rows.length) * vp.height;
    let left = sx + 12;
    let top = rowCenterY + 12;
    if (left + tooltipWidth > geometry.canvasWidth)
      left = Math.max(4, sx - tooltipWidth - 12);
    if (top + tooltipHeight > geometry.canvasHeight)
      top = Math.max(4, rowCenterY - tooltipHeight - 12);

    this.overlay.style.left = `${left}px`;
    this.overlay.style.top = `${top}px`;
    this.overlay.style.display = "block";
  };

  private readonly hideTooltip = () => {
    this.overlay.style.display = "none";
  };

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.host.getViewMode() !== "age") return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factor = Math.exp(normalizedWheelDelta(event) * 0.002);
    if (event.ctrlKey) {
      tuning.volumePerCssPixel = clamp(
        tuning.volumePerCssPixel * factor,
        MIN_VOLUME_PER_CSS_PIXEL,
        MAX_VOLUME_PER_CSS_PIXEL,
      );
    } else {
      tuning.ageScaleSeconds = clamp(
        tuning.ageScaleSeconds / factor,
        MIN_AGE_SCALE_SECONDS,
        MAX_AGE_SCALE_SECONDS,
      );
    }

    schedulePersistTuning();
    notifyTuningListeners();
    scheduleGlobalRedraw();
  };

  private installAgeLayout(
    rowCount: number,
    labels: readonly HTMLLabelElement[],
  ): void {
    const leftPadding = ageLabelGutterWidth(labels);
    let resize = false;
    if (this.host.plotter.padding.l !== leftPadding) {
      this.host.plotter.padding.l = leftPadding;
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
    const widthCss = `${leftPadding}px`;
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

  private refreshRecordingAgeLabels(force = false): void {
    const nowMs = Date.now();
    if (!force && nowMs - this.lastRecordingAgeLabelUpdateMs < 30_000) return;
    this.lastRecordingAgeLabelUpdateMs = nowMs;

    for (const label of this.collectControls()) {
      const age = label.querySelector<HTMLElement>(".cpv-recording-age");
      const tokenId = label.dataset.tokenId;
      if (!age || !tokenId) continue;

      const since = this.markets.get(tokenId)?.recordingSinceMs ?? null;
      if (since === null || !Number.isFinite(since)) {
        age.hidden = true;
        age.textContent = "";
        continue;
      }

      const duration = fmtRelativeTime((nowMs - since) / 1000);
      age.hidden = false;
      age.textContent = duration;
      age.title = `${duration} recorder history`;
    }
  }

  private scheduleDiffusionTimer(delayMs: number): void {
    if (this.host.getViewMode() !== "age") return;
    this.diffusionTimer = window.setTimeout(() => {
      this.diffusionTimer = undefined;
      if (this.host.getViewMode() === "age") this.host.requestDraw();
    }, Math.max(1, Math.ceil(delayMs)));
  }

  private cancelDiffusionTimer(): void {
    if (this.diffusionTimer === undefined) return;
    clearTimeout(this.diffusionTimer);
    this.diffusionTimer = undefined;
  }
}

function ageLabelGutterWidth(labels: readonly HTMLLabelElement[]): number {
  if (labels.length === 0) return AGE_LABEL_MIN_GUTTER_PX;

  let widest = 0;
  for (const label of labels) {
    const cached = Number(label.dataset.ageLabelWidth);
    if (!Number.isFinite(cached)) continue;
    const age = label.querySelector<HTMLElement>(".cpv-recording-age");
    const ageWidth =
      age && !age.hidden ? AGE_RECORDING_AGE_WIDTH_PX + AGE_LABEL_GAP_PX : 0;
    widest = Math.max(widest, cached + ageWidth);
  }

  return Math.ceil(
    clamp(
      widest + AGE_LABEL_HORIZONTAL_INSET_PX * 2 + 1,
      AGE_LABEL_MIN_GUTTER_PX,
      AGE_LABEL_MAX_GUTTER_PX,
    ),
  );
}

function measureIntrinsicTextWidth(text: HTMLElement): number {
  if (
    !text.style ||
    typeof (text as HTMLElement & { getBoundingClientRect?: unknown })
      .getBoundingClientRect !== "function"
  )
    return (text.textContent?.length ?? 0) * 6;

  const previous = {
    flex: text.style.flex,
    width: text.style.width,
    maxWidth: text.style.maxWidth,
    overflow: text.style.overflow,
    textOverflow: text.style.textOverflow,
  };

  // Measure the actual DOM font at max-content width, independent of whatever
  // gutter happened to be installed from the previous frame/event.
  text.style.flex = "none";
  text.style.width = "max-content";
  text.style.maxWidth = "none";
  text.style.overflow = "visible";
  text.style.textOverflow = "clip";
  const width = text.getBoundingClientRect().width;

  text.style.flex = previous.flex;
  text.style.width = previous.width;
  text.style.maxWidth = previous.maxWidth;
  text.style.overflow = previous.overflow;
  text.style.textOverflow = previous.textOverflow;
  return width;
}

function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  hover: BookHoverSnapshot,
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
  title.style.color = signedVolumeColor(
    isBid ? 1 : -1,
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  );
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

/** Draw only the vertical probability rails and 0/1 labels in age mode. */
function drawAgeAxes(frame: any): void {
  const { ctx, viewport: vp, theme } = frame;

  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(vp.l, vp.t);
  ctx.lineTo(vp.l, vp.t + vp.height);
  ctx.moveTo(vp.l + vp.width, vp.t);
  ctx.lineTo(vp.l + vp.width, vp.t + vp.height);
  ctx.stroke();

  ctx.fillStyle = theme.text;
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0", vp.l, vp.t + vp.height + 8);
  ctx.fillText("1", vp.l + vp.width, vp.t + vp.height + 8);

  ctx.beginPath();
  ctx.rect(vp.l, vp.t, vp.width, vp.height);
  ctx.clip();
}

function drawPressureStrip(
  frame: any,
  y: number,
  segments: readonly StaleSignedVolumeSegment[],
  colorScale: typeof DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  volumePerCssPixel: number,
  timeScaleSeconds: number,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);

  ctx.save();
  ctx.beginPath();
  ctx.rect(vp.l, geometry.topCss, vp.width, geometry.heightCss);
  ctx.clip();

  for (const segment of segments) {
    if (segment.volume === 0 || segment.ageMs === Infinity) continue;
    const x0 = snapToDevicePixel(
      vp.l + clamp(segment.lo, 0, 1) * vp.width,
      dpr,
    );
    const x1 = snapToDevicePixel(
      vp.l + clamp(segment.hi, 0, 1) * vp.width,
      dpr,
    );
    if (!(x1 > x0)) continue;

    const profile = pressureInkProfile(
      segment.volume,
      segment.ageMs,
      volumePerCssPixel,
      timeScaleSeconds,
      dpr,
      geometry.deviceHeight,
    );
    ctx.fillStyle = signedVolumeColor(segment.volume, colorScale);

    for (let py = 0; py < profile.length; py++) {
      const alpha = profile[py]!;
      if (!(alpha > 0)) continue;
      ctx.globalAlpha = alpha;
      ctx.fillRect(
        x0,
        geometry.topCss + py / dpr,
        x1 - x0,
        1 / dpr,
      );
    }
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

function gpuDiffusionDelayMs(timeScaleSeconds: number): number {
  // Resin is a slow visual memory; batching more elapsed diffusion into each
  // GPU step dramatically reduces canvas copies without changing the equation.
  return clamp(timeScaleSeconds * 60, 50, 500);
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

function scheduleGlobalRedraw(): void {
  if (globalRedrawRaf !== undefined) return;
  globalRedrawRaf = requestAnimationFrame(() => {
    globalRedrawRaf = undefined;
    for (const redraw of redrawCallbacks) redraw();
  });
}

function notifyTuningListeners(): void {
  const snapshot = getAgeStripTuning();
  for (const listener of tuningListeners) listener(snapshot);
}

function loadTuning(): AgeStripTuning {
  const fallback: AgeStripTuning = {
    ageScaleSeconds: 5,
    volumePerCssPixel: DEFAULT_VOLUME_PER_CSS_PIXEL,
  };

  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as StoredAgeStripTuning;
    const storedVolumeScale =
      typeof parsed.volumePerCssPixel === "number"
        ? parsed.volumePerCssPixel
        : parsed.volumeSoftLimit;
    return {
      ageScaleSeconds:
        typeof parsed.ageScaleSeconds === "number"
          ? clamp(
            parsed.ageScaleSeconds,
            MIN_AGE_SCALE_SECONDS,
            MAX_AGE_SCALE_SECONDS,
          )
          : fallback.ageScaleSeconds,
      volumePerCssPixel:
        typeof storedVolumeScale === "number"
          ? clamp(
            storedVolumeScale,
            MIN_VOLUME_PER_CSS_PIXEL,
            MAX_VOLUME_PER_CSS_PIXEL,
          )
          : fallback.volumePerCssPixel,
    };
  } catch {
    return fallback;
  }
}

function schedulePersistTuning(): void {
  if (tuningPersistTimer !== undefined) clearTimeout(tuningPersistTimer);
  tuningPersistTimer = window.setTimeout(() => {
    tuningPersistTimer = undefined;
    try {
      window.localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(tuning));
    } catch {
      // Preferences are best effort.
    }
  }, 200);
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
