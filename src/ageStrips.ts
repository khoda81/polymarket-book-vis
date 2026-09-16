import type { PolymarketCPV } from "./component";
import type { TokenBook } from "@/lib/orderBook";
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

/** Shared visual calibration across every event frame on the page. */
const tuning = {
  ageScaleSeconds: 5,
  volumeSoftLimit: DEFAULT_SIGNED_VOLUME_COLOR_SCALE.softLimit,
};

const redrawers = new Set<() => void>();

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

/**
 * Experimental age-mode renderer.
 *
 * The core component remains responsible for websocket ingestion and book
 * reconstruction. This adapter hooks the completed-book update boundary to
 * maintain the sample-and-hold field and replaces only the age-mode renderer.
 */
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
  const scratch = document.createElement("canvas");
  const scratchCtx = scratch.getContext("2d");
  if (!scratchCtx) throw new Error("2D canvas context is not available");

  const canvas = component.refs.canvas as HTMLCanvasElement;
  const canvasWrap = component.refs.canvasWrap;
  const toggles = component.refs.toggles;
  const toggleHomeParent = toggles.parentElement;
  const toggleHomeNextSibling = toggles.nextSibling;

  const redraw = () => component.reqDraw();
  redrawers.add(redraw);

  const originalUpdateSpreadAge = component.updateSpreadAge.bind(component);
  component.updateSpreadAge = (tokenId: string, nowMs: number) => {
    originalUpdateSpreadAge(tokenId, nowMs);
    const book = component.books[tokenId];
    if (!book) return;
    const memory = memories.get(tokenId) ?? new StaleSignedVolume();
    memory.update(book, nowMs);
    memories.set(tokenId, memory);
  };

  const originalBuildToggles = component.buildToggles.bind(component);
  component.buildToggles = (event: AdapterEvent) => {
    originalBuildToggles(event);
    annotateToggleLabels(component, event);
  };

  const originalLoad = component.load.bind(component);
  component.load = async (event: unknown) => {
    memories.clear();
    await originalLoad(event);
  };

  const originalDrawVolumeView = component.drawVolumeView.bind(component);
  component.drawVolumeView = () => {
    restoreVolumeLayout(
      component,
      toggles,
      canvasWrap,
      toggleHomeParent,
      toggleHomeNextSibling,
    );
    originalDrawVolumeView();
  };

  component.drawAgeView = () => {
    const rowControls = Array.from(
      toggles.querySelectorAll<HTMLLabelElement>("label[data-token-id]"),
    );
    const count = Math.max(1, rowControls.length);

    installAgeLayout(component, toggles, canvasWrap, count);

    const frame = component.plotter.beginFrame(component.theme, {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: count - 0.5 },
    });

    // Age mode uses HTML market controls in the y-axis gutter, so there are no
    // horizontal tick/grid lines competing with the thin market strips.
    frame.drawAxes({ yTicks: [] });
    positionRowControls(rowControls, frame, count);

    const nowMs = performance.now();
    const colorScale = {
      ...DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
      softLimit: tuning.volumeSoftLimit,
    };

    for (const [index, label] of rowControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;

      const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (checkbox && !checkbox.checked) continue;

      const segments = memories.get(tokenId)?.segments(nowMs) ?? [];
      if (segments.length === 0) continue;

      const y = count - 1 - index;
      drawRasterStrip(
        frame,
        y,
        segments,
        scratch,
        scratchCtx,
        colorScale,
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

    for (const requestDraw of redrawers) requestDraw();
  };

  canvas.addEventListener("wheel", handleAgeWheel, {
    capture: true,
    passive: false,
  });

  const originalDestroy = component.destroy.bind(component);
  component.destroy = () => {
    redrawers.delete(redraw);
    canvas.removeEventListener("wheel", handleAgeWheel, true);
    originalDestroy();
  };
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

function installAgeLayout(
  component: {
    plotter: PlotterAdapter;
  },
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
  canvasWrap: HTMLElement,
  homeParent: HTMLElement | null,
  homeNextSibling: ChildNode | null,
): void {
  let resize = false;

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
  for (const label of toggles.querySelectorAll<HTMLElement>("label"))
    label.style.top = "";

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

function drawRasterStrip(
  frame: any,
  y: number,
  segments: readonly StaleSignedVolumeSegment[],
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

  for (const segment of segments) {
    const x0 = clamp(Math.round(segment.lo * width), 0, width);
    const x1 = clamp(Math.round(segment.hi * width), 0, width);
    if (x1 <= x0) continue;

    scratchCtx.globalAlpha = staleVolumeAlpha(
      segment.ageMs,
      tuning.ageScaleSeconds,
    );
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

function normalizedWheelDelta(event: WheelEvent): number {
  let delta = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 400;
  return clamp(delta, -500, 500);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
