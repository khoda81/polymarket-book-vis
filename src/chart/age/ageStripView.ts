import type { ObservationTime } from "@/domain/pressure/observationClock";
import { AGE_ROW_BAND_PX } from "@/chart/age/ageStripTuning";
import type { AgeStripTuningStore } from "@/chart/age/ageStripTuningStore";
import type { ChartTheme, OrderBookPlotter } from "@/rendering/renderer";
import type { MarketGroupModel } from "@/chart/model/marketGroupModel.svelte";
import {
  AGE_TIME_GUTTER_PX,
  type AgeStripGeometry,
  VOLUME_LEFT_PADDING_PX,
  VOLUME_RIGHT_PADDING_PX,
  ageLabelGutterWidth,
  positionRowControls,
  rowRasterGeometry,
} from "./ageStripLayout";
import { drawAgeAxes } from "./ageStripRendering";
import { GpuPressureLayer, type GpuPressureRow } from "./gpuPressureLayer";
import { AgeStripClock } from "./ageStripClock";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import { agePressureSurface } from "./ageStripPressureProjection";
import { AgeStripTooltip } from "./ageStripTooltip";
import type { AgeRowOrientation } from "./ageStripOrientation";
import { signedVolumeColor } from "@/rendering/colors/signedVolume";

export interface AgeStripRenderState {
  readonly viewMode: "volume" | "age";
  readonly rowOrientation: AgeRowOrientation;
  readonly opacityTimeMs: ObservationTime;
  readonly volumePerCssPixel: number;
  readonly ghostHalfLifeMs: number;
}

export interface AgeStripHost {
  readonly model: MarketGroupModel;
  readonly tuning: AgeStripTuningStore;
  readonly canvas: HTMLCanvasElement;
  readonly pressureCanvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly plotter: OrderBookPlotter;
  readonly getTheme: () => ChartTheme;
  readonly getRenderState: () => AgeStripRenderState;
}

/**
 * Age-mode projection of live books plus the shared compressed pressure
 * history. Rendering stays on one visible Canvas2D surface; recorder hydration,
 * live updates, ghost memory, resolution state, clocks, and tooltips all feed
 * this same projection.
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
      canvasWrap: host.canvasWrap,
      getViewMode: () => host.getRenderState().viewMode,
      getObservationTime: (tokenId) =>
        host.model.pressure.observationTime(tokenId),
      getTiming: (tokenId) => host.model.pressure.timing(tokenId),
      getRowOrientation: () => host.getRenderState().rowOrientation,
      getTokenName: (tokenId) => host.model.marketTokenName(tokenId),
      getTokenColor: (tokenId, opposite) =>
        signedVolumeColor(
          opposite ? 1 : -1,
          host.model.pressureColorScale(tokenId),
        ),
    });
    this.tooltip = new AgeStripTooltip({
      getOpacityTime: () => host.getRenderState().opacityTimeMs,
      canvas: host.canvas,
      getViewMode: () => host.getRenderState().viewMode,
      getRowOrientation: () => host.getRenderState().rowOrientation,
      getVolumePerCssPixel: () => host.getRenderState().volumePerCssPixel,
      getGhostHalfLifeMs: () => host.getRenderState().ghostHalfLifeMs,
      getPressureBand: (tokenId, price, volume) =>
        host.model.pressure.bandAtPoint(tokenId, price, volume),
      getTokenName: (tokenId) => host.model.tokenName(tokenId),
      getMarketName: (tokenId) => host.model.marketName(tokenId),
      getPressureColorScale: (tokenId) =>
        host.model.pressureColorScale(tokenId),
    });

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
  }

  draw(): void {
    const controls = this.collectControls();
    const activeControls = controls.filter((label) => this.isActive(label));
    const rowCount = Math.max(1, activeControls.length);

    this.installAgeLayout(rowCount, activeControls);

    const theme = this.host.getTheme();
    const frame = this.host.plotter.beginFrame(
      theme,
      {
        xRange: { min: 0, max: 1 },
        yRange: { min: -0.5, max: rowCount - 0.5 },
      },
      { transparentBackground: true },
    );
    positionRowControls(activeControls, frame, rowCount);

    const vp = frame.viewport;
    const dpr = window.devicePixelRatio || 1;
    const geometry: AgeStripGeometry = {
      viewport: {
        l: vp.l,
        t: vp.t,
        width: vp.width,
        height: vp.height,
      },
      rows: activeControls.map((label, index) => {
        const tokenId = label.dataset.tokenId ?? `missing-row-${index}`;
        const y = rowCount - 1 - index;
        const raster = rowRasterGeometry(frame.toScreenY(0, y), dpr);

        return {
          tokenId,
          oppositeTokenId: this.host.model.oppositeTokenId(tokenId),
          centerY: raster.centerCss,
          topY: raster.topCss,
          bottomY: raster.topCss + raster.heightCss,
        };
      }),
      canvasWidth: vp.l + vp.width + this.host.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.host.plotter.padding.b,
    };
    this.geometry = geometry;
    this.clock.setEnabled(true);
    this.clock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);
    this.renderPressure(geometry);

    drawAgeAxes(frame, rowCount, activeControls, (tokenId) =>
      this.host.model.pressureColorScale(tokenId),
    );
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
    const rowOrientation = state.rowOrientation;
    const gpuRows: GpuPressureRow[] = [];

    for (const row of geometry.rows) {
      const tokenId = row.tokenId;
      const primaryMemory = this.host.model.pressure.memory(tokenId);
      const oppositeTokenId = row.oppositeTokenId;
      const oppositeMemory = oppositeTokenId
        ? this.host.model.pressure.memory(oppositeTokenId)
        : undefined;
      if (!primaryMemory && !oppositeMemory) continue;

      const colorScale = this.host.model.pressureColorScale(tokenId);
      const centerCss =
        row.centerY ??
        geometry.viewport.t +
          ((geometry.rows.indexOf(row) + 0.5) / geometry.rows.length) *
            geometry.viewport.height;
      const topCss = row.topY ?? centerCss - AGE_ROW_BAND_PX / 2;
      const bottomCss = row.bottomY ?? centerCss + AGE_ROW_BAND_PX / 2;
      gpuRows.push({
        key: tokenId,
        centerCss,
        heightCss: bottomCss - topCss,
        surfaces: [
          ...(primaryMemory
            ? [
                agePressureSurface(
                  tokenId,
                  primaryMemory.renderDataRevision(),
                  primaryMemory.renderMaxPrice(),
                  primaryMemory.renderRuns(),
                  primaryMemory.renderCumulativeShares(),
                  (revision) =>
                    primaryMemory.renderFirstChangedRunSince(revision),
                  primaryMemory.renderCurrentValidThroughMs(),
                  this.host.model.pressure.renderExtents(tokenId),
                  this.host.model.pressure.renderExtentRevision(tokenId),
                  colorScale,
                  "primary",
                  rowOrientation,
                ),
              ]
            : []),
          ...(oppositeMemory
            ? [
                agePressureSurface(
                  oppositeTokenId!,
                  oppositeMemory.renderDataRevision(),
                  oppositeMemory.renderMaxPrice(),
                  oppositeMemory.renderRuns(),
                  oppositeMemory.renderCumulativeShares(),
                  (revision) =>
                    oppositeMemory.renderFirstChangedRunSince(revision),
                  oppositeMemory.renderCurrentValidThroughMs(),
                  this.host.model.pressure.renderExtents(oppositeTokenId!),
                  this.host.model.pressure.renderExtentRevision(
                    oppositeTokenId!,
                  ),
                  colorScale,
                  "opposite",
                  rowOrientation,
                ),
              ]
            : []),
        ],
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
      dpr: window.devicePixelRatio || 1,
      volumePerCssPixel: state.volumePerCssPixel,
      ghostHalfLifeMs: state.ghostHalfLifeMs,
      opacityTimeMs: state.opacityTimeMs,
      background: theme.bg,
    });
  }

  prepareVolumeView(): void {
    this.pressureLayer?.setVisible(false);
    this.geometry = null;
    this.clock.setGeometry(null);
    this.clock.setEnabled(false);
    this.tooltip.clear();
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

    if (this.host.toggles.style.width !== "")
      this.host.toggles.style.width = "";

    if (resize) this.host.plotter.resize();
    this.layoutMode = "volume";
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

  private collectControls(): HTMLLabelElement[] {
    return Array.from(
      this.host.toggles.querySelectorAll<HTMLLabelElement>(
        "label[data-token-id]",
      ),
    ).sort(
      (a, b) =>
        Number(a.dataset.marketOrder ?? 0) - Number(b.dataset.marketOrder ?? 0),
    );
  }

  private isActive(label: HTMLLabelElement): boolean {
    const tokenId = label.dataset.tokenId;
    return !!tokenId && this.host.model.isTokenActive(tokenId);
  }
}
