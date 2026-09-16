import type { PolymarketCPV } from "./component";
import { canonicalSpread, type TokenBook } from "@/lib/orderBook";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "@/lib/signedVolume";
import {
  StaleSignedVolume,
  type StaleSignedVolumeSegment,
} from "@/lib/staleSignedVolume";

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

const tuning = loadTuning();
const userHiddenMarketIds = loadStringSet(HIDDEN_MARKETS_STORAGE_KEY);
let tuningPersistTimer: number | undefined;
let globalRedrawRaf: number | undefined;

interface RenderRegistration {
  readonly redraw: () => void;
  visible: boolean;
}

const registrations = new Set<RenderRegistration>();

interface AdapterMarket {
  id: string;
  question: string;
  outcomes: { yes: { tokenId: string | null } };
  state?: unknown;
  [key: string]: unknown;
}

interface AdapterEvent {
  markets: AdapterMarket[];
}

interface PlotterAdapter {
  padding: { l: number; r: number; t: number; b: number };
  resize(): void;
  beginFrame(
    theme: unknown,
    domain: {
      xRange: { min: number; max: number };
      yRange: { min: number; max: number };
    },
  ): any;
}

interface ComponentAdapter {
  event?: AdapterEvent;
  activeTokens: Set<string>;
  books: Record<string, TokenBook<string>>;
  titles: Record<string, string>;
  theme: unknown;
  viewMode: "volume" | "age";
  refs: Record<string, HTMLElement>;
  plotter: PlotterAdapter;
  ageTimer?: number;
  startAgeTimer(): void;
  updateSpreadAge(tokenId: string, nowMs: number): void;
  buildToggles(event: AdapterEvent): void;
  drawAgeView(): void;
  drawVolumeView(): void;
  reqDraw(): void;
  load(event: unknown): Promise<void>;
  destroy(): void;
}

/**
 * Install the age-strip view on an existing PolymarketCPV instance.
 *
 * The base component remains responsible for websocket ingestion and the live
 * HalfBooks. This adapter owns only the derived sample-and-hold field, age-view
 * controls/layout, and visual calibration.
 */
export function installAgeStripView(chart: PolymarketCPV): void {
  const component = chart as unknown as ComponentAdapter;

  // The old tower view animated age with a 500 ms interval. Strip age is
  // derived lazily from timestamps, so there is no state to poll.
  if (component.ageTimer !== undefined) {
    clearInterval(component.ageTimer);
    component.ageTimer = undefined;
  }
  component.startAgeTimer = () => {};

  const canvas = component.refs.canvas as HTMLCanvasElement;
  const canvasWrap = component.refs.canvasWrap;
  const toggles = component.refs.toggles;
  const toggleHomeParent = toggles.parentElement;
  const toggleHomeNextSibling = toggles.nextSibling;

  const hiddenTray = document.createElement("div");
  hiddenTray.className = "cpv-hidden-markets";
  hiddenTray.hidden = true;
  canvasWrap.insertAdjacentElement("afterend", hiddenTray);

  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new Error("2D canvas context is not available");

  const memories = new Map<string, StaleSignedVolume>();
  const lastMarketUpdateMs = new Map<string, number>();
  const initializedVisibility = new Set<string>();
  let fadeTimer: number | undefined;

  const registration: RenderRegistration = {
    redraw: () => component.reqDraw(),
    visible: true,
  };
  registrations.add(registration);

  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (registration.visible === visible) return;
      registration.visible = visible;
      if (!visible) cancelFadeTimer();
      else component.reqDraw();
    },
    { rootMargin: "200px" },
  );
  visibilityObserver.observe(canvasWrap);

  // readEvents() calls this once after each completed book mutation. Replace
  // the legacy SpreadAge update entirely: the strip view has one derived state.
  component.updateSpreadAge = (tokenId: string, nowMs: number) => {
    const book = component.books[tokenId];
    if (!book) return;

    lastMarketUpdateMs.set(tokenId, nowMs);
    const memory = memories.get(tokenId) ?? new StaleSignedVolume();
    memory.update(book, nowMs);
    memories.set(tokenId, memory);

    if (initializedVisibility.has(tokenId)) return;
    initializedVisibility.add(tokenId);
    if (hasRealOrders(book)) return;

    const label = findControlByToken(toggles, hiddenTray, tokenId);
    const marketId = label?.dataset.marketId;
    if (!label || !marketId || userHiddenMarketIds.has(marketId)) return;

    const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!checkbox) return;
    checkbox.checked = false;
    component.activeTokens.delete(tokenId);
  };

  const originalBuildToggles = component.buildToggles.bind(component);
  component.buildToggles = (event: AdapterEvent) => {
    hiddenTray.replaceChildren();
    originalBuildToggles(event);
    configureMarketControls(component, event, toggles);
  };

  const originalLoad = component.load.bind(component);
  component.load = async (event: unknown) => {
    cancelFadeTimer();
    memories.clear();
    lastMarketUpdateMs.clear();
    initializedVisibility.clear();
    hiddenTray.replaceChildren();
    await originalLoad(event);
  };

  const originalDrawVolumeView = component.drawVolumeView.bind(component);
  component.drawVolumeView = () => {
    cancelFadeTimer();
    restoreVolumeLayout(
      component,
      toggles,
      hiddenTray,
      canvasWrap,
      toggleHomeParent,
      toggleHomeNextSibling,
    );
    originalDrawVolumeView();
  };

  component.drawAgeView = () => {
    cancelFadeTimer();

    const controls = collectControls(toggles, hiddenTray);
    syncControlPlacement(component.activeTokens, toggles, hiddenTray, controls);
    const activeControls = controls.filter((label) =>
      isControlActive(label, component.activeTokens),
    );
    const rowCount = Math.max(1, activeControls.length);

    installAgeLayout(component, toggles, canvasWrap, rowCount);

    const frame = component.plotter.beginFrame(component.theme, {
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

      const book = component.books[tokenId];
      const memory = memories.get(tokenId);
      if (!book || !memory) continue;

      const segments = memory.segments(nowMs);
      if (segments.length === 0) continue;

      const marketAgeMs = Math.max(
        0,
        nowMs - (lastMarketUpdateMs.get(tokenId) ?? nowMs),
      );
      const spread = canonicalSpread(book);
      const y = rowCount - 1 - index;

      drawRasterStrip(
        frame,
        y,
        segments,
        spread,
        marketAgeMs,
        scratch,
        scratchCtx,
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
      registration.visible &&
      component.viewMode === "age" &&
      Number.isFinite(nextFadeDelayMs)
    ) {
      fadeTimer = window.setTimeout(() => {
        fadeTimer = undefined;
        if (registration.visible && component.viewMode === "age")
          component.reqDraw();
      }, Math.max(1, Math.ceil(nextFadeDelayMs)));
    }
  };

  const handleAgeWheel = (event: WheelEvent) => {
    if (component.viewMode !== "age") return;

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

  canvas.addEventListener("wheel", handleAgeWheel, {
    capture: true,
    passive: false,
  });

  const originalDestroy = component.destroy.bind(component);
  component.destroy = () => {
    cancelFadeTimer();
    visibilityObserver.disconnect();
    registrations.delete(registration);
    canvas.removeEventListener("wheel", handleAgeWheel, true);
    hiddenTray.remove();
    originalDestroy();
  };

  function cancelFadeTimer() {
    if (fadeTimer === undefined) return;
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
  }
}

function configureMarketControls(
  component: Pick<ComponentAdapter, "activeTokens" | "titles">,
  event: AdapterEvent,
  toggles: HTMLElement,
): void {
  const markets = event.markets.filter((market) => {
    const tokenId = market.outcomes.yes.tokenId;
    return tokenId !== null && component.activeTokens.has(tokenId);
  });
  const labels = Array.from(toggles.querySelectorAll<HTMLLabelElement>("label"));
  const orderByToken = resolutionOrder(event.markets);

  for (const [index, label] of labels.entries()) {
    const market = markets[index];
    const tokenId = market?.outcomes.yes.tokenId;
    if (!market || !tokenId) continue;

    label.dataset.tokenId = tokenId;
    label.dataset.marketId = market.id;
    label.dataset.marketOrder = String(orderByToken.get(tokenId) ?? index);

    const dot = label.querySelector<HTMLSpanElement>("span");
    dot?.classList.add("cpv-market-dot");

    for (const node of Array.from(label.childNodes))
      if (node.nodeType === Node.TEXT_NODE) node.remove();

    const text = component.titles[market.id] ?? market.question;
    const textSpan = document.createElement("span");
    textSpan.className = "cpv-market-label-text";
    textSpan.textContent = text;
    label.appendChild(textSpan);
    label.title = text;

    const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!checkbox) continue;

    if (userHiddenMarketIds.has(market.id)) {
      checkbox.checked = false;
      component.activeTokens.delete(tokenId);
    }

    checkbox.addEventListener("change", () => {
      if (component.activeTokens.has(tokenId)) userHiddenMarketIds.delete(market.id);
      else userHiddenMarketIds.add(market.id);
      persistStringSet(HIDDEN_MARKETS_STORAGE_KEY, userHiddenMarketIds);
    });
  }
}

function collectControls(
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
): HTMLLabelElement[] {
  return [
    ...toggles.querySelectorAll<HTMLLabelElement>("label[data-token-id]"),
    ...hiddenTray.querySelectorAll<HTMLLabelElement>("label[data-token-id]"),
  ].sort(
    (a, b) =>
      Number(a.dataset.marketOrder ?? 0) - Number(b.dataset.marketOrder ?? 0),
  );
}

function isControlActive(
  label: HTMLLabelElement,
  activeTokens: ReadonlySet<string>,
): boolean {
  const tokenId = label.dataset.tokenId;
  return !!tokenId && activeTokens.has(tokenId);
}

function syncControlPlacement(
  activeTokens: ReadonlySet<string>,
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
  labels: readonly HTMLLabelElement[],
): void {
  let hiddenCount = 0;

  for (const label of labels) {
    const active = isControlActive(label, activeTokens);
    const parent = active ? toggles : hiddenTray;
    if (label.parentElement !== parent) parent.appendChild(label);

    if (!active) {
      if (label.style.top !== "") label.style.top = "";
      hiddenCount++;
    }
  }

  const shouldHideTray = hiddenCount === 0;
  if (hiddenTray.hidden !== shouldHideTray) hiddenTray.hidden = shouldHideTray;
}

function installAgeLayout(
  component: Pick<ComponentAdapter, "plotter">,
  toggles: HTMLElement,
  canvasWrap: HTMLElement,
  rowCount: number,
): void {
  let resize = false;

  if (component.plotter.padding.l !== AGE_LEFT_PADDING_PX) {
    component.plotter.padding.l = AGE_LEFT_PADDING_PX;
    resize = true;
  }

  const height =
    component.plotter.padding.t +
    component.plotter.padding.b +
    rowCount * AGE_ROW_BAND_PX;
  const heightCss = `${height}px`;
  if (canvasWrap.style.height !== heightCss) {
    canvasWrap.style.height = heightCss;
    resize = true;
  }

  if (toggles.parentElement !== canvasWrap) {
    canvasWrap.appendChild(toggles);
    resize = true;
  }

  if (!toggles.classList.contains("cpv-toggles--age-axis"))
    toggles.classList.add("cpv-toggles--age-axis");
  const widthCss = `${AGE_LEFT_PADDING_PX}px`;
  if (toggles.style.width !== widthCss) toggles.style.width = widthCss;

  if (resize) component.plotter.resize();
}

function restoreVolumeLayout(
  component: Pick<ComponentAdapter, "plotter">,
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
  canvasWrap: HTMLElement,
  homeParent: HTMLElement | null,
  homeNextSibling: ChildNode | null,
): void {
  let resize = false;

  for (const label of collectControls(toggles, hiddenTray)) {
    if (label.style.top !== "") label.style.top = "";
    if (label.parentElement !== toggles) toggles.appendChild(label);
  }
  if (!hiddenTray.hidden) hiddenTray.hidden = true;

  if (component.plotter.padding.l !== VOLUME_LEFT_PADDING_PX) {
    component.plotter.padding.l = VOLUME_LEFT_PADDING_PX;
    resize = true;
  }
  if (canvasWrap.style.height !== "") {
    canvasWrap.style.height = "";
    resize = true;
  }

  toggles.classList.remove("cpv-toggles--age-axis");
  if (toggles.style.width !== "") toggles.style.width = "";

  if (homeParent && toggles.parentElement !== homeParent) {
    if (homeNextSibling?.parentNode === homeParent)
      homeParent.insertBefore(toggles, homeNextSibling);
    else homeParent.appendChild(toggles);
  }

  if (resize) component.plotter.resize();
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

function findControlByToken(
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
  tokenId: string,
): HTMLLabelElement | undefined {
  return collectControls(toggles, hiddenTray).find(
    (label) => label.dataset.tokenId === tokenId,
  );
}

function resolutionOrder(markets: readonly AdapterMarket[]): Map<string, number> {
  const sorted = markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionTimestamp(market),
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

function resolutionTimestamp(market: AdapterMarket): number {
  const state = asRecord(market.state);
  const candidates = [
    state?.endDate,
    state?.end_date,
    market.endDate,
    market.endDateIso,
    market.end_date,
    market.end_date_iso,
  ];

  for (const candidate of candidates) {
    if (candidate instanceof Date) return candidate.getTime();
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
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
