import { canonicalSpread, type TokenBook } from "@/lib/orderBook";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "@/lib/signedVolume";
import {
  StaleSignedVolume,
  type StaleSignedVolumeSegment,
} from "@/lib/staleSignedVolume";
import type { Event } from "@polymarket/client";

const AGE_LEFT_PADDING_PX = 176;
const VOLUME_LEFT_PADDING_PX = 60;
const AGE_ROW_BAND_PX = 36;
const AGE_LINE_WIDTH_PX = 4;

const MIN_AGE_SCALE_SECONDS = 0.05;
const MAX_AGE_SCALE_SECONDS = 7 * 24 * 60 * 60;
const MIN_VOLUME_SOFT_LIMIT = 1;
const MAX_VOLUME_SOFT_LIMIT = 1e9;
const STALE_ALPHA_FLOOR = 0.05;
const MARKET_ALPHA_FLOOR = 0.2;
const FADE_EXPONENT = 0.35;
const MAX_TIMEOUT_MS = 2_147_000_000;

const TUNING_STORAGE_KEY = "polymarket-book-vis.age-strip-tuning.v1";
const HIDDEN_MARKETS_STORAGE_KEY =
  "polymarket-book-vis.age-strip-hidden-markets.v1";

interface AgeStripTuning {
  ageScaleSeconds: number;
  volumeSoftLimit: number;
}

interface MarketRuntimeState {
  readonly field: StaleSignedVolume;
  lastUpdateMs: number;
  visibilityInitialized: boolean;
}

interface RenderRegistration {
  readonly redraw: () => void;
  visible: boolean;
}

export interface AgeStripHost {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly plotter: OrderBookPlotter;
  readonly activeTokens: Set<string>;
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  readonly getTitle: (marketId: string) => string | undefined;
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
  readonly requestDraw: () => void;
}

const tuning = loadTuning();
const userHiddenMarketIds = loadStringSet(HIDDEN_MARKETS_STORAGE_KEY);
const registrations = new Set<RenderRegistration>();
let tuningPersistTimer: number | undefined;
let globalRedrawRaf: number | undefined;

/**
 * Age-mode projection of the live order books.
 *
 * Per market we retain exactly one derived state: a sample-and-hold signed
 * volume field plus the timestamp of the latest websocket update. Visibility
 * lives in the component's activeTokens set; checkboxes are only UI controls.
 */
export class AgeStripView {
  private readonly host: AgeStripHost;
  private readonly hiddenTray: HTMLDivElement;
  private readonly scratch = document.createElement("canvas");
  private readonly scratchCtx: CanvasRenderingContext2D;
  private readonly markets = new Map<string, MarketRuntimeState>();
  private readonly toggleHomeParent: HTMLElement | null;
  private readonly toggleHomeNextSibling: ChildNode | null;
  private readonly registration: RenderRegistration;
  private readonly visibilityObserver: IntersectionObserver;

  private fadeTimer: number | undefined;
  private layoutMode: "age" | "volume" | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.toggleHomeParent = host.toggles.parentElement;
    this.toggleHomeNextSibling = host.toggles.nextSibling;

    const scratchCtx = this.scratch.getContext("2d");
    if (!scratchCtx) throw new Error("2D canvas context is not available");
    this.scratchCtx = scratchCtx;

    this.hiddenTray = document.createElement("div");
    this.hiddenTray.className = "cpv-hidden-markets";
    this.hiddenTray.hidden = true;
    host.canvasWrap.insertAdjacentElement("afterend", this.hiddenTray);

    this.registration = {
      redraw: host.requestDraw,
      visible: true,
    };
    registrations.add(this.registration);

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        if (this.registration.visible === visible) return;
        this.registration.visible = visible;
        if (!visible) this.cancelFadeTimer();
        else this.host.requestDraw();
      },
      { rootMargin: "200px" },
    );
    this.visibilityObserver.observe(host.canvasWrap);

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
  }

  reset(): void {
    this.cancelFadeTimer();
    this.markets.clear();
    this.hiddenTray.replaceChildren();
    this.layoutMode = null;
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

      const text = this.host.getTitle(market.id) ?? market.question;
      const textSpan = document.createElement("span");
      textSpan.className = "cpv-market-label-text";
      textSpan.textContent = text;
      label.appendChild(textSpan);
      label.title = text;

      const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (!checkbox) continue;

      if (userHiddenMarketIds.has(market.id)) {
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

  onBookUpdate(tokenId: string, nowMs: number): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    let state = this.markets.get(tokenId);
    if (!state) {
      state = {
        field: new StaleSignedVolume(),
        lastUpdateMs: nowMs,
        visibilityInitialized: false,
      };
      this.markets.set(tokenId, state);
    }

    state.field.update(book, nowMs);
    state.lastUpdateMs = nowMs;

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
    this.cancelFadeTimer();

    const controls = this.collectControls();
    this.syncControlPlacement(controls);
    const activeControls = controls.filter((label) => this.isActive(label));
    const rowCount = Math.max(1, activeControls.length);

    this.installAgeLayout(rowCount);

    const frame = this.host.plotter.beginFrame(this.host.getTheme(), {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: rowCount - 0.5 },
    });
    drawAgeAxes(frame);
    positionRowControls(activeControls, frame, rowCount);

    const nowMs = performance.now();
    const colorScale = {
      ...DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
      softLimit: tuning.volumeSoftLimit,
    };
    let nextFadeDelayMs = Infinity;

    for (const [index, label] of activeControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;

      const book = this.host.getBook(tokenId);
      const state = this.markets.get(tokenId);
      if (!book || !state) continue;

      const segments = state.field.segments(nowMs);
      if (segments.length === 0) continue;

      const marketAgeMs = Math.max(0, nowMs - state.lastUpdateMs);
      const spread = canonicalSpread(book);
      const y = rowCount - 1 - index;

      drawRasterStrip(
        frame,
        y,
        segments,
        spread,
        marketAgeMs,
        this.scratch,
        this.scratchCtx,
        colorScale,
      );

      nextFadeDelayMs = Math.min(
        nextFadeDelayMs,
        nextStripAlphaChangeDelayMs(
          segments,
          spread,
          marketAgeMs,
          tuning.ageScaleSeconds,
        ),
      );
    }

    if (
      this.registration.visible &&
      this.host.getViewMode() === "age" &&
      Number.isFinite(nextFadeDelayMs)
    ) {
      this.fadeTimer = window.setTimeout(() => {
        this.fadeTimer = undefined;
        if (this.registration.visible && this.host.getViewMode() === "age")
          this.host.requestDraw();
      }, Math.max(1, Math.ceil(nextFadeDelayMs)));
    }
  }

  prepareVolumeView(): void {
    this.cancelFadeTimer();
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
    this.cancelFadeTimer();
    this.visibilityObserver.disconnect();
    registrations.delete(this.registration);
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.hiddenTray.remove();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.host.getViewMode() !== "age") return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factor = Math.exp(normalizedWheelDelta(event) * 0.002);
    if (event.ctrlKey) {
      tuning.volumeSoftLimit = clamp(
        tuning.volumeSoftLimit * factor,
        MIN_VOLUME_SOFT_LIMIT,
        MAX_VOLUME_SOFT_LIMIT,
      );
    } else {
      tuning.ageScaleSeconds = clamp(
        tuning.ageScaleSeconds * factor,
        MIN_AGE_SCALE_SECONDS,
        MAX_AGE_SCALE_SECONDS,
      );
    }

    schedulePersistTuning();
    scheduleGlobalRedraw();
  };

  private installAgeLayout(rowCount: number): void {
    let resize = false;
    if (this.host.plotter.padding.l !== AGE_LEFT_PADDING_PX) {
      this.host.plotter.padding.l = AGE_LEFT_PADDING_PX;
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
    const widthCss = `${AGE_LEFT_PADDING_PX}px`;
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

  private cancelFadeTimer(): void {
    if (this.fadeTimer === undefined) return;
    clearTimeout(this.fadeTimer);
    this.fadeTimer = undefined;
  }
}

function positionRowControls(
  labels: readonly HTMLLabelElement[],
  frame: any,
  rowCount: number,
): void {
  for (const [index, label] of labels.entries()) {
    const y = rowCount - 1 - index;
    const top = `${frame.toScreenY(0, y)}px`;
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

function drawRasterStrip(
  frame: any,
  y: number,
  segments: readonly StaleSignedVolumeSegment[],
  spread: { bid: number; ask: number },
  marketAgeMs: number,
  scratch: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
  colorScale: typeof DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(frame.viewport.width * dpr));
  const height = Math.max(1, Math.round(AGE_LINE_WIDTH_PX * dpr));

  if (scratch.width !== width) scratch.width = width;
  if (scratch.height !== height) scratch.height = height;

  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.clearRect(0, 0, width, height);

  const marketAlpha = ageAlpha(
    marketAgeMs,
    tuning.ageScaleSeconds,
    MARKET_ALPHA_FLOOR,
  );

  for (const segment of segments) {
    const x0 = clamp(Math.round(segment.lo * width), 0, width);
    const x1 = clamp(Math.round(segment.hi * width), 0, width);
    if (x1 <= x0) continue;

    const midpoint = (segment.lo + segment.hi) / 2;
    const memoryAlpha =
      midpoint > spread.bid && midpoint < spread.ask
        ? ageAlpha(segment.ageMs, tuning.ageScaleSeconds, STALE_ALPHA_FLOOR)
        : 1;

    scratchCtx.globalAlpha = quantizedAlpha(marketAlpha * memoryAlpha);
    scratchCtx.fillStyle = signedVolumeColor(segment.volume, colorScale);
    scratchCtx.fillRect(x0, 0, x1 - x0, height);
  }
  scratchCtx.globalAlpha = 1;

  const screenY = frame.toScreenY(0, y);
  frame.ctx.save();
  frame.ctx.imageSmoothingEnabled = false;
  frame.ctx.drawImage(
    scratch,
    frame.viewport.l,
    screenY - AGE_LINE_WIDTH_PX / 2,
    frame.viewport.width,
    AGE_LINE_WIDTH_PX,
  );
  frame.ctx.restore();
}

function nextStripAlphaChangeDelayMs(
  segments: readonly StaleSignedVolumeSegment[],
  spread: { bid: number; ask: number },
  marketAgeMs: number,
  timeScaleSeconds: number,
): number {
  let next = nextQuantizedAlphaChangeDelayMs(
    marketAgeMs,
    null,
    timeScaleSeconds,
  );

  const seenStaleAges = new Set<number>();
  for (const segment of segments) {
    const midpoint = (segment.lo + segment.hi) / 2;
    if (!(midpoint > spread.bid && midpoint < spread.ask)) continue;
    if (seenStaleAges.has(segment.ageMs)) continue;
    seenStaleAges.add(segment.ageMs);
    next = Math.min(
      next,
      nextQuantizedAlphaChangeDelayMs(
        marketAgeMs,
        segment.ageMs,
        timeScaleSeconds,
      ),
    );
  }
  return next;
}

function nextQuantizedAlphaChangeDelayMs(
  marketAgeMs: number,
  staleAgeMs: number | null,
  timeScaleSeconds: number,
): number {
  const alphaAt = (deltaMs: number) => {
    const marketAlpha = ageAlpha(
      marketAgeMs + deltaMs,
      timeScaleSeconds,
      MARKET_ALPHA_FLOOR,
    );
    const memoryAlpha =
      staleAgeMs === null
        ? 1
        : ageAlpha(
            staleAgeMs + deltaMs,
            timeScaleSeconds,
            STALE_ALPHA_FLOOR,
          );
    return marketAlpha * memoryAlpha;
  };

  const currentByte = Math.round(alphaAt(0) * 255);
  const plateauByte = Math.round(
    MARKET_ALPHA_FLOOR *
      (staleAgeMs === null ? 1 : STALE_ALPHA_FLOOR) *
      255,
  );
  if (currentByte <= plateauByte) return Infinity;

  const threshold = (currentByte - 0.5) / 255;
  let lo = 0;
  let hi = 1;

  while (hi < MAX_TIMEOUT_MS && alphaAt(hi) >= threshold) hi *= 2;
  hi = Math.min(hi, MAX_TIMEOUT_MS);
  if (alphaAt(hi) >= threshold) return Infinity;

  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (alphaAt(mid) >= threshold) lo = mid;
    else hi = mid;
  }
  return hi + 0.5;
}

function ageAlpha(
  ageMs: number,
  timeScaleSeconds: number,
  floor: number,
): number {
  if (!(ageMs > 0)) return 1;
  return Math.max(
    floor,
    Math.pow(1 + ageMs / 1000 / timeScaleSeconds, -FADE_EXPONENT),
  );
}

function quantizedAlpha(alpha: number): number {
  return Math.round(clamp(alpha, 0, 1) * 255) / 255;
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
    for (const registration of registrations)
      if (registration.visible) registration.redraw();
  });
}

function loadTuning(): AgeStripTuning {
  const fallback: AgeStripTuning = {
    ageScaleSeconds: 5,
    volumeSoftLimit: DEFAULT_SIGNED_VOLUME_COLOR_SCALE.softLimit,
  };

  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AgeStripTuning>;
    return {
      ageScaleSeconds:
        typeof parsed.ageScaleSeconds === "number"
          ? clamp(
              parsed.ageScaleSeconds,
              MIN_AGE_SCALE_SECONDS,
              MAX_AGE_SCALE_SECONDS,
            )
          : fallback.ageScaleSeconds,
      volumeSoftLimit:
        typeof parsed.volumeSoftLimit === "number"
          ? clamp(
              parsed.volumeSoftLimit,
              MIN_VOLUME_SOFT_LIMIT,
              MAX_VOLUME_SOFT_LIMIT,
            )
          : fallback.volumeSoftLimit,
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
