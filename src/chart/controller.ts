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

type DrawKind = "opacity" | "pressure" | "full";

const DRAW_PRIORITY: Readonly<Record<DrawKind, number>> = {
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
  private pendingDraw: DrawKind | null = null;
  private destroyed = false;

  constructor(
    surface: ChartSurfaceElements,
    private readonly model: MarketGroupModel,
    tuning: AgeStripTuningStore,
    initialState: ChartRenderInput,
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

    let kind: DrawKind | null = null;
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

  private reqDraw(kind: DrawKind): void {
    if (
      this.pendingDraw === null ||
      DRAW_PRIORITY[kind] > DRAW_PRIORITY[this.pendingDraw]
    )
      this.pendingDraw = kind;

    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw(): void {
    this.raf = null;
    const kind = this.pendingDraw ?? "full";
    this.pendingDraw = null;

    if (this.renderState.viewMode === "age") {
      if (kind === "opacity" && this.ageView.refreshOpacity()) return;
      if (kind !== "full" && this.ageView.refreshPressure()) return;
      this.ageView.draw();
      return;
    }

    this.ageView.prepareVolumeView();
    this.volumeView.draw();
  }
}
