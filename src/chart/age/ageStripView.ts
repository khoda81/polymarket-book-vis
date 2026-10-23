import type { ObservationTime } from "@/domain/pressure/observationClock";
import { AGE_ROW_BAND_PX } from "@/chart/age/ageStripTuning";
import type { AgeStripTuningStore } from "@/chart/age/ageStripTuningStore";
import type { WallClock } from "@/shared/wallClock";
import type { ChartTheme, OrderBookPlotter } from "@/rendering/renderer";
import type { AgeStripPressureState } from "./ageStripPressureState";
import {
  AGE_TIME_GUTTER_PX,
  type AgeStripGeometry,
  VOLUME_LEFT_PADDING_PX,
  VOLUME_RIGHT_PADDING_PX,
  ageLabelGutterWidth,
  positionRowControls,
  rasterizeAgeRows,
} from "./ageStripLayout";
import { drawAgeAxes } from "./ageStripRendering";
import { GpuPressureLayer, type GpuPressureRow } from "./gpuPressureLayer";
import { AgeStripClock } from "./ageStripClock";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import {
  barPressureSurface,
  type TrackRenderData,
} from "./ageStripPressureProjection";
import { AgeStripTooltip } from "./ageStripTooltip";
import type { PressureRow } from "./pressureRows";

export interface AgeStripRenderState {
  readonly viewMode: "volume" | "age";
  readonly opacityTimeMs: ObservationTime;
  readonly volumePerCssPixel: number;
  readonly ghostHalfLifeMs: number;
}

export interface AgeStripHost {
  /** Pressure histories, keyed by the tracks rows refer to. */
  readonly pressure: AgeStripPressureState;
  /**
   * Rows to draw, top to bottom, read on every full draw. Each row's DOM label
   * carries data-row-key.
   */
  readonly getRows: () => readonly PressureRow[];
  readonly tuning: AgeStripTuningStore;
  readonly wallClock: WallClock;
  readonly canvas: HTMLCanvasElement;
  readonly pressureCanvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly plotter: OrderBookPlotter;
  readonly getTheme: () => ChartTheme;
  readonly getRenderState: () => AgeStripRenderState;
}

/**
 * Age-mode drawing of pressure rows: each row's bars draw half-book pressure
 * histories around the row centerline. Pressure is drawn by a WebGL2 layer on
 * its own canvas; labels, axes, clocks and tooltips stay on the Canvas2D
 * annotation surface above it.
 */
export class AgeStripView {
  private readonly host: AgeStripHost;
  private readonly clock: AgeStripClock;
  private readonly tooltip: AgeStripTooltip;
  private pressureLayer: GpuPressureLayer | null = null;
  private geometry: AgeStripGeometry | null = null;
  private layoutMode: "age" | "volume" | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.clock = new AgeStripClock({
      wallClock: host.wallClock,
      canvasWrap: host.canvasWrap,
      getGeometry: () => this.geometry,
      getViewMode: () => host.getRenderState().viewMode,
      getRecordingSinceMs: (track) => host.pressure.recordingSinceMs(track),
    });
    this.tooltip = new AgeStripTooltip({
      wallClock: host.wallClock,
      getGeometry: () => this.geometry,
      getOpacityTime: () => host.getRenderState().opacityTimeMs,
      canvas: host.canvas,
      getViewMode: () => host.getRenderState().viewMode,
      getVolumePerCssPixel: () => host.getRenderState().volumePerCssPixel,
      getGhostHalfLifeMs: () => host.getRenderState().ghostHalfLifeMs,
      getPressureBand: (track, price, volume) =>
        host.pressure.bandAtPoint(track, price, volume),
    });

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
  }

  draw(): void {
    const rows = this.host.getRows();
    const labelByKey = new Map(
      this.rowLabels().map((label) => [label.dataset.rowKey, label]),
    );
    const labels = rows.map((row) => labelByKey.get(row.key) ?? null);
    const rowCount = Math.max(1, rows.length);

    this.installAgeLayout(
      rowCount,
      labels.filter((label) => label !== null),
    );

    const theme = this.host.getTheme();
    const frame = this.host.plotter.beginFrame(
      theme,
      {
        xRange: { min: 0, max: 1 },
        yRange: { min: -0.5, max: rowCount - 0.5 },
      },
      { transparentBackground: true },
    );
    const vp = frame.viewport;
    const rasterRows = rasterizeAgeRows(
      vp.t,
      vp.height,
      rowCount,
      this.host.plotter.height,
      Math.max(1, frame.canvas.height),
    );
    positionRowControls(labels, rasterRows);
    const geometry: AgeStripGeometry = {
      viewport: {
        l: vp.l,
        t: vp.t,
        width: vp.width,
        height: vp.height,
      },
      rows: rows.map((row, index) => ({ row, ...rasterRows[index]! })),
      canvasWidth: this.host.plotter.width,
      canvasHeight: this.host.plotter.height,
    };
    this.renderPressure(geometry);

    drawAgeAxes(frame, geometry.rows);
    this.setGeometry(geometry);
  }

  /** Publish the drawn layout once; annotations and hit testing only read it. */
  private setGeometry(geometry: AgeStripGeometry | null): void {
    this.geometry = geometry;
    this.clock.refresh();
    this.tooltip.refresh();
  }

  refreshAnnotations(): void {
    this.clock.refresh();
  }

  refreshOpacity(): boolean {
    const state = this.host.getRenderState();
    return (
      state.viewMode === "age" &&
      !!this.pressureLayer?.refreshOpacity(
        state.opacityTimeMs,
        state.ghostHalfLifeMs,
      )
    );
  }

  refreshPressure(): boolean {
    const geometry = this.geometry;
    if (this.host.getRenderState().viewMode !== "age" || !geometry)
      return false;
    this.renderPressure(geometry);
    return true;
  }

  private renderPressure(geometry: AgeStripGeometry): void {
    const state = this.host.getRenderState();
    const dpr = window.devicePixelRatio || 1;
    const scaleY =
      Math.max(1, Math.floor(geometry.canvasHeight * dpr)) /
      geometry.canvasHeight;
    const gpuRows: GpuPressureRow[] = [];

    for (const drawn of geometry.rows) {
      const surfaces = drawn.row.bars.flatMap((bar) => {
        const track = this.trackRenderData(bar.track);
        return track ? [barPressureSurface(bar, track)] : [];
      });
      if (surfaces.length === 0) continue;

      gpuRows.push({
        key: drawn.row.key,
        topDevice: Math.round(drawn.topCss * scaleY),
        centerDevice: Math.round(drawn.centerCss * scaleY),
        bottomDevice: Math.round(drawn.bottomCss * scaleY),
        surfaces,
      });
    }

    const pressureLayer =
      this.pressureLayer ??
      (this.pressureLayer = new GpuPressureLayer(this.host.pressureCanvas));
    const theme = this.host.getTheme();
    pressureLayer.render({
      rows: gpuRows,
      viewport: { l: geometry.viewport.l, width: geometry.viewport.width },
      cssWidth: geometry.canvasWidth,
      cssHeight: geometry.canvasHeight,
      dpr,
      volumePerCssPixel: state.volumePerCssPixel,
      ghostHalfLifeMs: state.ghostHalfLifeMs,
      opacityTimeMs: state.opacityTimeMs,
      background: theme.bg,
    });
  }

  prepareVolumeView(): void {
    this.pressureLayer?.setVisible(false);
    this.setGeometry(null);
    this.tooltip.clear();
    if (this.layoutMode === "volume") return;

    for (const label of this.rowLabels())
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

    if (this.host.toggles.style.width !== "")
      this.host.toggles.style.width = "";

    if (resize) this.host.plotter.resize();
    this.layoutMode = "volume";
  }

  setPaused(paused: boolean): void {
    this.clock.setPaused(paused);
    if (paused) this.tooltip.clear();
  }

  destroy(): void {
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.clock.destroy();
    this.tooltip.destroy();
    this.pressureLayer?.destroy();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (
      this.host.getRenderState().viewMode !== "age" ||
      !handleAgeStripTuningWheel(event, this.host.tuning)
    )
      return;

    event.preventDefault();
    event.stopImmediatePropagation();
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

    const widthCss = `${rightPadding}px`;
    if (this.host.toggles.style.width !== widthCss)
      this.host.toggles.style.width = widthCss;

    if (resize) this.host.plotter.resize();
    this.layoutMode = "age";
  }

  private rowLabels(): HTMLLabelElement[] {
    return Array.from(
      this.host.toggles.querySelectorAll<HTMLLabelElement>(
        "label[data-row-key]",
      ),
    );
  }

  private trackRenderData(track: string): TrackRenderData | null {
    const memory = this.host.pressure.memory(track);
    if (!memory) return null;
    return {
      dataRevision: memory.renderDataRevision(),
      runs: memory.renderRuns(),
      cumulativeShares: memory.renderCumulativeShares(),
      firstChangedRunSince: (revision) =>
        memory.renderFirstChangedRunSince(revision),
      currentValidThroughMs: memory.validThroughMs(),
      extents: this.host.pressure.renderExtents(track),
      extentRevision: this.host.pressure.renderExtentRevision(track),
    };
  }
}
