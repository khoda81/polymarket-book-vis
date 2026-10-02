import type { ViewMode } from "@/domain/markets/chartState";
import { OrderBookPlotter, type ChartTheme } from "@/rendering/renderer";
import { chartThemeForDarkMode } from "./chartTheme";
import { AgeStripView, type AgeStripRenderState } from "./age/ageStripView";
import type { AgeRowOrientation } from "./age/ageStripOrientation";
import { VolumeBookView } from "./volume/volumeBookView";
import type { MarketGroupModel } from "./model/marketGroupModel.svelte";
import type { ObservationTime } from "@/domain/pressure/observationClock";
import type { AgeStripTuningStore } from "./age/ageStripTuningStore";

export interface ChartSurfaceElements {
  readonly canvas: HTMLCanvasElement;
  readonly pressureCanvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
}

export interface ChartRenderInput {
  readonly viewMode: ViewMode;
  readonly ageRowOrientation: AgeRowOrientation;
  readonly bookRevision: number;
  readonly pressureRevision: number;
  readonly visibilityRevision: number;
  readonly recordingRevision: number;
  readonly opacityTimeMs: ObservationTime;
  readonly volumePerCssPixel: number;
  readonly ghostHalfLifeMs: number;
}

export type ChartDrawKind = "opacity" | "pressure" | "full";

export interface ChartPendingState {
  readonly kind: ChartDrawKind;
  readonly queueAgeMs: number;
  readonly requestCount: number;
}

export interface ChartRenderedState {
  readonly kind: ChartDrawKind;
  readonly opacityTimeMs: ObservationTime;
  readonly pressureRevision: number;
  readonly bookRevision: number;
  readonly renderedAtMs: number;
  readonly queueDelayMs: number;
  readonly latestRequestDelayMs: number;
  readonly drawCpuMs: number;
  readonly coalescedRequests: number;
}

const DRAW_PRIORITY: Readonly<Record<ChartDrawKind, number>> = {
  opacity: 0,
  pressure: 1,
  full: 2,
};

/**
 * Imperative canvas renderer for one market group.
 *
 * Domain/network state lives in MarketGroupModel. Svelte supplies coherent
 * render snapshots through update(); this class only decides how much retained
 * canvas work that snapshot requires.
 */
export class ChartController {
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly plotter: OrderBookPlotter;
  private readonly ageView: AgeStripView;
  private readonly volumeView: VolumeBookView;

  private theme: ChartTheme;
  private renderState: ChartRenderInput;
  private raf: number | null = null;
  private pendingDraw: ChartDrawKind | null = null;
  private queuedAtMs = 0;
  private latestRequestAtMs = 0;
  private pendingRequestCount = 0;
  private destroyed = false;

  constructor(
    surface: ChartSurfaceElements,
    private readonly model: MarketGroupModel,
    tuning: AgeStripTuningStore,
    initialState: ChartRenderInput,
    private readonly onRendered?: (state: ChartRenderedState) => void,
    private readonly onPending?: (state: ChartPendingState | null) => void,
  ) {
    this.renderState = initialState;
    this.model.setViewMode(initialState.viewMode);

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = chartThemeForDarkMode(this.themeQuery.matches);

    this.plotter = new OrderBookPlotter(surface.canvas);
    this.ageView = new AgeStripView({
      model,
      tuning,
      canvas: surface.canvas,
      pressureCanvas: surface.pressureCanvas,
      canvasWrap: surface.canvasWrap,
      toggles: surface.toggles,
      plotter: this.plotter,
      getTheme: () => this.theme,
      getRenderState: () => this.ageRenderState(),
    });

    this.volumeView = new VolumeBookView({
      plotter: this.plotter,
      definition: model.definition,
      activeTokens: model.activeTokens,
      getBook: (tokenId) => model.getBook(tokenId),
      getTheme: () => this.theme,
      isActive: () => this.renderState.viewMode === "volume",
      requestDraw: () => this.reqDraw("full"),
    });
    this.plotter.onZoom = (delta) => this.volumeView.zoom(delta);
    this.plotter.onPointer = (pointer) => this.volumeView.setPointer(pointer);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.reqDraw("full");
    });
    this.resizeObserver.observe(surface.canvas);
    this.themeQuery.addEventListener("change", this.handleThemeChange);

    this.reqDraw("full");
  }

  update(next: ChartRenderInput): void {
    if (this.destroyed) return;

    const previous = this.renderState;
    this.renderState = next;
    this.model.setViewMode(next.viewMode);

    if (next.recordingRevision !== previous.recordingRevision)
      this.ageView.refreshAnnotations();

    let kind: ChartDrawKind | null = null;
    if (
      next.viewMode !== previous.viewMode ||
      next.ageRowOrientation !== previous.ageRowOrientation ||
      next.visibilityRevision !== previous.visibilityRevision
    ) {
      kind = "full";
    } else if (next.viewMode === "volume") {
      if (next.bookRevision !== previous.bookRevision) kind = "full";
    } else if (
      next.pressureRevision !== previous.pressureRevision ||
      next.volumePerCssPixel !== previous.volumePerCssPixel ||
      next.ghostHalfLifeMs !== previous.ghostHalfLifeMs
    ) {
      kind = "pressure";
    } else if (next.opacityTimeMs !== previous.opacityTimeMs) {
      kind = "opacity";
    }

    if (kind) this.reqDraw(kind);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ageView.destroy();
    this.plotter.destroy();
    this.resizeObserver.disconnect();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private readonly handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = chartThemeForDarkMode(event.matches);
    this.reqDraw("full");
  };

  private ageRenderState(): AgeStripRenderState {
    return {
      viewMode: this.renderState.viewMode,
      rowOrientation: this.renderState.ageRowOrientation,
      opacityTimeMs: this.renderState.opacityTimeMs,
      volumePerCssPixel: this.renderState.volumePerCssPixel,
      ghostHalfLifeMs: this.renderState.ghostHalfLifeMs,
    };
  }

  private reqDraw(kind: ChartDrawKind): void {
    const nowMs = performance.now();
    this.latestRequestAtMs = nowMs;
    this.pendingRequestCount++;

    if (
      this.pendingDraw === null ||
      DRAW_PRIORITY[kind] > DRAW_PRIORITY[this.pendingDraw]
    )
      this.pendingDraw = kind;

    if (this.raf === null) {
      this.queuedAtMs = nowMs;
      this.raf = requestAnimationFrame(() => this.performDraw());
    }

    this.onPending?.({
      kind: this.pendingDraw,
      queueAgeMs: nowMs - this.queuedAtMs,
      requestCount: this.pendingRequestCount,
    });
  }

  private performDraw(): void {
    this.raf = null;
    const kind = this.pendingDraw ?? "full";
    const startedAtMs = performance.now();
    const queueDelayMs = startedAtMs - this.queuedAtMs;
    const latestRequestDelayMs = startedAtMs - this.latestRequestAtMs;
    const requestCount = this.pendingRequestCount;
    this.pendingDraw = null;
    this.pendingRequestCount = 0;
    this.onPending?.(null);

    let renderedKind: ChartDrawKind = kind;
    if (this.renderState.viewMode === "age") {
      if (kind === "opacity" && this.ageView.refreshOpacity()) {
        renderedKind = "opacity";
      } else if (kind !== "full" && this.ageView.refreshPressure()) {
        renderedKind = "pressure";
      } else {
        this.ageView.draw();
        renderedKind = "full";
      }
    } else {
      this.ageView.prepareVolumeView();
      this.volumeView.draw();
      renderedKind = "full";
    }

    this.recordRendered(
      renderedKind,
      queueDelayMs,
      latestRequestDelayMs,
      requestCount,
      performance.now() - startedAtMs,
    );
  }

  private recordRendered(
    kind: ChartDrawKind,
    queueDelayMs: number,
    latestRequestDelayMs: number,
    requestCount: number,
    drawCpuMs: number,
  ): void {
    this.onRendered?.({
      kind,
      opacityTimeMs: this.renderState.opacityTimeMs,
      pressureRevision: this.renderState.pressureRevision,
      bookRevision: this.renderState.bookRevision,
      renderedAtMs: performance.now(),
      queueDelayMs,
      latestRequestDelayMs,
      drawCpuMs,
      coalescedRequests: Math.max(0, requestCount - 1),
    });
  }
}
