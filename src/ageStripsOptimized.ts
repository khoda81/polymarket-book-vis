import type { PolymarketCPV } from "./component";
import { canonicalSpread, type TokenBook } from "@/lib/orderBook";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "@/lib/signedVolume";
import {
  StaleSignedVolume,
  staleVolumeAlpha,
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

const tuning = loadStoredTuning();
let tuningPersistTimer: number | undefined;

function loadStoredTuning(): {
  ageScaleSeconds: number;
  volumeSoftLimit: number;
} {
  let ageScaleSeconds = 5;
  let volumeSoftLimit = DEFAULT_SIGNED_VOLUME_COLOR_SCALE.softLimit;

  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return { ageScaleSeconds, volumeSoftLimit };
    const parsed = JSON.parse(raw) as {
      ageScaleSeconds?: unknown;
      volumeSoftLimit?: unknown;
    };
    if (typeof parsed.ageScaleSeconds === "number")
      ageScaleSeconds = clamp(
        parsed.ageScaleSeconds,
        MIN_AGE_SCALE_SECONDS,
        MAX_AGE_SCALE_SECONDS,
      );
    if (typeof parsed.volumeSoftLimit === "number")
      volumeSoftLimit = clamp(
        parsed.volumeSoftLimit,
        MIN_VOLUME_SOFT_LIMIT,
        MAX_VOLUME_SOFT_LIMIT,
      );
  } catch {
    // Persistence is optional; keep defaults if storage is unavailable/corrupt.
  }

  return { ageScaleSeconds, volumeSoftLimit };
}

function schedulePersistTuning(): void {
  if (tuningPersistTimer !== undefined) clearTimeout(tuningPersistTimer);
  tuningPersistTimer = window.setTimeout(() => {
    tuningPersistTimer = undefined;
    try {
      window.localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(tuning));
    } catch {
      // Ignore storage failures (private mode/quota/etc.).
    }
  }, 200);
}

interface RenderRegistration {
  redraw: () => void;
  visible: boolean;
}

const registrations = new Set<RenderRegistration>();
let globalTuningRaf: number | undefined;

function scheduleGlobalTuningRedraw(): void {
  if (globalTuningRaf !== undefined) return;
  globalTuningRaf = requestAnimationFrame(() => {
    globalTuningRaf = undefined;
    for (const registration of registrations)
      if (registration.visible) registration.redraw();
  });
}

interface AdapterMarket {
  id: string;
  question: string;
  outcomes: { yes: { tokenId: string | null } };
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

export function installAgeStripView(chart: PolymarketCPV): void {
  const component = chart as unknown as {
    event?: AdapterEvent;
    activeTokens: Set<string>;
    books: Record<string, TokenBook<string>>;
    titles: Record<string, string>;
    theme: unknown;
    viewMode: "volume" | "age";
    refs: Record<string, HTMLElement>;
    plotter: PlotterAdapter;
    updateSpreadAge(tokenId: string, nowMs: number): void;
    buildToggles(event: AdapterEvent): void;
    drawAgeView(): void;
    drawVolumeView(): void;
    reqDraw(): void;
    load(event: unknown): Promise<void>;
    destroy(): void;
  };

  const memories = new Map<string, StaleSignedVolume>();
  const lastMarketUpdateMs = new Map<string, number>();
  let fadeTimer: number | undefined;

  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new Error("2D canvas context is not available");

  const canvas = component.refs.canvas as HTMLCanvasElement;
  const canvasWrap = component.refs.canvasWrap;
  const toggles = component.refs.toggles;
  const toggleHomeParent = toggles.parentElement;
  const toggleHomeNextSibling = toggles.nextSibling;

  const hiddenTray = document.createElement("div");
  hiddenTray.className = "cpv-hidden-markets";
  hiddenTray.hidden = true;
  canvasWrap.insertAdjacentElement("afterend", hiddenTray);

  const registration: RenderRegistration = {
    redraw: () => component.reqDraw(),
    visible: true,
  };
  registrations.add(registration);

  const visibilityObserver = new IntersectionObserver((entries) => {
    const visible = entries.some((entry) => entry.isIntersecting);
    if (registration.visible === visible) return;
    registration.visible = visible;
    if (!visible) {
      cancelFadeTimer();
      return;
    }
    component.reqDraw();
  }, { rootMargin: "200px" });
  visibilityObserver.observe(canvasWrap);

  const originalUpdateSpreadAge = component.updateSpreadAge.bind(component);
  component.updateSpreadAge = (tokenId: string, nowMs: number) => {
    originalUpdateSpreadAge(tokenId, nowMs);
    const book = component.books[tokenId];
    if (!book) return;

    lastMarketUpdateMs.set(tokenId, nowMs);
    const memory = memories.get(tokenId) ?? new StaleSignedVolume();
    memory.update(book, nowMs);
    memories.set(tokenId, memory);
  };

  const originalBuildToggles = component.buildToggles.bind(component);
  component.buildToggles = (event: AdapterEvent) => {
    hiddenTray.replaceChildren();
    originalBuildToggles(event);
    annotateToggleLabels(component, event);
  };

  const originalLoad = component.load.bind(component);
  component.load = async (event: unknown) => {
    cancelFadeTimer();
    memories.clear();
    lastMarketUpdateMs.clear();
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

    const allControls = collectControls(toggles, hiddenTray);
    syncAgeControlPlacement(toggles, hiddenTray, allControls);

    const activeControls = allControls.filter((label) =>
      isControlEnabled(label, component.activeTokens),
    );
    const count = Math.max(1, activeControls.length);

    installAgeLayout(component, toggles, canvasWrap, count);

    const frame = component.plotter.beginFrame(component.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: count - 0.5 },
    });
    drawAgeAxes(frame);
    positionRowControls(activeControls, frame, count);

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
      if (!book) continue;

      const segments = memories.get(tokenId)?.segments(nowMs) ?? [];
      if (segments.length === 0) continue;

      const marketAgeMs = Math.max(
        0,
        nowMs - (lastMarketUpdateMs.get(tokenId) ?? nowMs),
      );
      const spread = canonicalSpread(book);
      const y = count - 1 - index;

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
      fadeTimer = window.setTimeout(
        () => {
          fadeTimer = undefined;
          if (registration.visible && component.viewMode === "age")
            component.reqDraw();
        },
        Math.max(1, Math.ceil(nextFadeDelayMs)),
      );
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
    scheduleGlobalTuningRedraw();
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

function annotateToggleLabels(
  component: {
    activeTokens: Set<string>;
    titles: Record<string, string>;
    refs: Record<string, HTMLElement>;
  },
  event: AdapterEvent,
): void {
  const markets = event.markets.filter((market) => {
    const tokenId = market.outcomes.yes.tokenId;
    return tokenId !== null && component.activeTokens.has(tokenId);
  });
  const labels = Array.from(
    component.refs.toggles.querySelectorAll<HTMLLabelElement>("label"),
  );

  for (const [index, label] of labels.entries()) {
    const market = markets[index];
    const tokenId = market?.outcomes.yes.tokenId;
    if (!market || tokenId === null || tokenId === undefined) continue;

    label.dataset.tokenId = tokenId;
    label.dataset.marketOrder = String(index);
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

function isControlEnabled(
  label: HTMLLabelElement,
  activeTokens: ReadonlySet<string>,
): boolean {
  const tokenId = label.dataset.tokenId;
  const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
  return !!tokenId && !!checkbox?.checked && activeTokens.has(tokenId);
}

function syncAgeControlPlacement(
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
  labels: readonly HTMLLabelElement[],
): void {
  let hiddenCount = 0;
  for (const label of labels) {
    const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (checkbox?.checked) {
      toggles.appendChild(label);
    } else {
      label.style.top = "";
      hiddenTray.appendChild(label);
      hiddenCount++;
    }
  }
  hiddenTray.hidden = hiddenCount === 0;
}

function installAgeLayout(
  component: { plotter: PlotterAdapter },
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
  toggles.classList.add("cpv-toggles--age-axis");
  toggles.style.width = `${AGE_LEFT_PADDING_PX}px`;

  if (resize) component.plotter.resize();
}

function restoreVolumeLayout(
  component: { plotter: PlotterAdapter },
  toggles: HTMLElement,
  hiddenTray: HTMLElement,
  canvasWrap: HTMLElement,
  homeParent: HTMLElement | null,
  homeNextSibling: ChildNode | null,
): void {
  let resize = false;

  for (const label of collectControls(toggles, hiddenTray)) {
    label.style.top = "";
    toggles.appendChild(label);
  }
  hiddenTray.hidden = true;

  if (component.plotter.padding.l !== VOLUME_LEFT_PADDING_PX) {
    component.plotter.padding.l = VOLUME_LEFT_PADDING_PX;
    resize = true;
  }
  if (canvasWrap.style.height !== "") {
    canvasWrap.style.height = "";
    resize = true;
  }

  toggles.classList.remove("cpv-toggles--age-axis");
  toggles.style.width = "";

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
  count: number,
): void {
  for (const [index, label] of labels.entries()) {
    const y = count - 1 - index;
    label.style.top = `${frame.toScreenY(0, y)}px`;
  }
}

function drawAgeAxes(frame: any): void {
  const { ctx, viewport: vp, theme, domain } = frame;

  // Keep the left/right alignment rails, but age strips no longer need a box.
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
  const x0 = frame.toScreenX(domain.xRange.min, 0);
  const x1 = frame.toScreenX(domain.xRange.max, 0);
  ctx.fillText(String(domain.xRange.min), x0, vp.t + vp.height + 8);
  ctx.fillText(String(domain.xRange.max), x1, vp.t + vp.height + 8);

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

  const marketAlpha = fadeAlpha(
    marketAgeMs,
    tuning.ageScaleSeconds,
    MARKET_ALPHA_FLOOR,
  );

  for (const segment of segments) {
    const x0 = clamp(Math.round(segment.lo * width), 0, width);
    const x1 = clamp(Math.round(segment.hi * width), 0, width);
    if (x1 <= x0) continue;

    const midpoint = (segment.lo + segment.hi) / 2;
    const insideSpread = midpoint > spread.bid && midpoint < spread.ask;
    const memoryAlpha = insideSpread
      ? staleVolumeAlpha(segment.ageMs, tuning.ageScaleSeconds)
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
    const marketAlpha = fadeAlpha(
      marketAgeMs + deltaMs,
      timeScaleSeconds,
      MARKET_ALPHA_FLOOR,
    );
    const memoryAlpha =
      staleAgeMs === null
        ? 1
        : fadeAlpha(
            staleAgeMs + deltaMs,
            timeScaleSeconds,
            STALE_ALPHA_FLOOR,
          );
    return marketAlpha * memoryAlpha;
  };

  const currentAlpha = alphaAt(0);
  const currentByte = Math.round(currentAlpha * 255);
  const plateau = MARKET_ALPHA_FLOOR *
    (staleAgeMs === null ? 1 : STALE_ALPHA_FLOOR);
  const plateauByte = Math.round(plateau * 255);
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

function fadeAlpha(
  ageMs: number,
  timeScaleSeconds: number,
  floor: number,
): number {
  if (!(ageMs > 0)) return 1;
  const ageSeconds = ageMs / 1000;
  return Math.max(
    floor,
    Math.pow(1 + ageSeconds / timeScaleSeconds, -FADE_EXPONENT),
  );
}

function quantizedAlpha(alpha: number): number {
  return Math.round(clamp(alpha, 0, 1) * 255) / 255;
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
