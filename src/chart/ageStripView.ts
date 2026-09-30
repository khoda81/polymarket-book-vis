import { observationClock, opacityReference } from "@/lib/observationClock";
import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import type { FeeSchedule } from "@/lib/feeSchedule";
import type { TokenBook } from "@/lib/orderBook";
import type { PressureFrontierSnapshot } from "@/lib/pressureFrontierSnapshot";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import type { SignedVolumeColorScale } from "@/lib/signedVolume";
import {
  AGE_TIME_GUTTER_PX,
  type AgeStripGeometry,
  VOLUME_LEFT_PADDING_PX,
  VOLUME_RIGHT_PADDING_PX,
  ageLabelGutterWidth,
  hasRealOrders,
  positionRowControls,
  rowRasterGeometry,
} from "./ageStripLayout";
import { drawAgeAxes } from "./ageStripRendering";
import { GpuPressureLayer, type GpuPressureRow } from "./gpuPressureLayer";
import { AgeStripClock } from "./ageStripClock";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import { AgeStripPressureState } from "./ageStripPressureState";
import {
  agePressureSourceTokenForSemanticToken,
  agePressureSurface,
} from "./ageStripPressureProjection";
import type { LiveBookUpdate } from "./liveBookFeed";
import { AgeStripTooltip } from "./ageStripTooltip";
import type { AgeRowOrientation } from "./ageStripOrientation";
import { signedVolumeColor } from "@/lib/signedVolume";
import type { PublicClient } from "@polymarket/client";
import type { ChartMarketControl } from "@/lib/chartDefinition";

export interface AgeStripHost {
  readonly client: PublicClient;
  readonly getMarketTokenName: (tokenId: string) => string;
  readonly canvas: HTMLCanvasElement;
  readonly pressureCanvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly plotter: OrderBookPlotter;
  readonly activeTokens: Set<string>;
  readonly getBook: (tokenId: string) => TokenBook | undefined;
  readonly getFeeSchedule: (tokenId: string) => FeeSchedule;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getMarketName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenId: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
  readonly getRowOrientation: () => AgeRowOrientation;
  readonly hideToken: (tokenId: string) => void;
  readonly requestDraw: () => void;
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
  private readonly unsubscribeTuning: () => void;
  private readonly pressure = new AgeStripPressureState();
  private pressureLayer: GpuPressureLayer | null = null;
  private readonly visibilityInitialized = new Set<string>();
  private readonly unsubscribeObservation: () => void;
  private layoutMode: "age" | "volume" | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.clock = new AgeStripClock({
      canvasWrap: host.canvasWrap,
      getViewMode: host.getViewMode,
      client: host.client,
      getObservationTime: (tokenId) => this.pressure.observationTime(tokenId),
      getTiming: (tokenId) => this.pressure.timing(tokenId),
      getRowOrientation: host.getRowOrientation,
      getTokenName: host.getMarketTokenName,
      getTokenColor: (tokenId, opposite) =>
        signedVolumeColor(
          opposite ? 1 : -1,
          host.getPressureColorScale(tokenId),
        ),
    });
    this.unsubscribeObservation = observationClock(host.client).subscribe(
      (reference) => {
        if (host.getViewMode() !== "age" || !this.pressureLayer) return;
        if (
          !this.pressureLayer.refreshOpacity(
            opacityReference(reference),
            getAgeStripTuning().ghostHalfLifeMs,
          )
        )
          host.requestDraw();
      },
    );
    this.tooltip = new AgeStripTooltip({
      getOpacityTime: () =>
        opacityReference(observationClock(host.client).readReference()),
      canvas: host.canvas,
      getViewMode: host.getViewMode,
      getRowOrientation: host.getRowOrientation,
      getPressureBand: (tokenId, price, volume) =>
        this.pressure.bandAtPoint(tokenId, price, volume),
      getTokenName: host.getTokenName,
      getMarketName: host.getMarketName,
      getPressureColorScale: host.getPressureColorScale,
    });

    this.unsubscribeTuning = subscribeAgeStripTuning(() => {
      host.requestDraw();
    });

    host.canvas.addEventListener("wheel", this.handleWheel, {
      capture: true,
      passive: false,
    });
  }

  reset(): void {
    this.pressure.reset();
    this.pressureLayer?.invalidate();
    this.visibilityInitialized.clear();
    this.clock.reset();
    this.tooltip.clear();
    this.layoutMode = null;
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    this.pressure.setRecordingCoverage(recordingSinceMsByToken);
    this.clock.refresh();
    this.host.requestDraw();
  }

  hydratePressureMemory(
    snapshotsByToken: Readonly<Record<string, PressureFrontierSnapshot>>,
  ): void {
    this.pressure.hydrate(
      snapshotsByToken,
      (tokenId) => this.host.getBook(tokenId),
      (tokenId) => this.host.getFeeSchedule(tokenId),
    );
    this.pressureLayer?.invalidate();
    observationClock(this.host.client).changed();
  }

  configureMarkets(controls: readonly ChartMarketControl[]): void {
    this.visibilityInitialized.clear();
    this.pressure.configure(
      controls.flatMap((control) => {
        const rows = [
          {
            tokenId: control.tokenId,
            resolutionMs: control.resolutionMs,
          },
        ];
        const oppositeTokenId = control.market.outcomes.no.tokenId;
        if (oppositeTokenId)
          rows.push({
            tokenId: oppositeTokenId,
            resolutionMs: control.resolutionMs,
          });
        return rows;
      }),
    );

    for (const control of controls) {
      if (control.lifecycle.kind !== "resolved") continue;
      // Static market metadata gives us the terminal winner, but its
      // end/closed timestamp is not causal pressure evidence.
      this.applyResolvedPressure(
        control.tokenId,
        control.market.outcomes.no.tokenId,
        control.lifecycle.winningTokenId,
        null,
      );
    }

    this.pressureLayer?.invalidate();
  }

  onBookUpdate(tokenId: string, update: LiveBookUpdate): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    this.pressure.applyBookUpdate(
      tokenId,
      book,
      this.host.getFeeSchedule(tokenId),
      update,
    );

    observationClock(this.host.client).changed();
    if (this.visibilityInitialized.has(tokenId)) return;
    this.visibilityInitialized.add(tokenId);
    if (hasRealOrders(book)) return;

    if (this.host.activeTokens.has(tokenId)) this.host.hideToken(tokenId);
  }

  resolveMarket(
    primaryTokenId: string,
    winningTokenId: string,
    resolvedAtMs: number | null,
  ): void {
    this.applyResolvedPressure(
      primaryTokenId,
      this.host.getOppositeTokenId(primaryTokenId),
      winningTokenId,
      resolvedAtMs,
    );
    this.pressureLayer?.invalidate();
    this.clock.refresh();
    observationClock(this.host.client).changed();
  }

  private applyResolvedPressure(
    primaryTokenId: string,
    oppositeTokenId: string | null | undefined,
    winningTokenId: string,
    resolvedAtMs: number | null,
  ): void {
    const unboundedSourceTokenId = agePressureSourceTokenForSemanticToken(
      primaryTokenId,
      oppositeTokenId,
      winningTokenId,
    );

    this.pressure.resolveSource(
      primaryTokenId,
      primaryTokenId === unboundedSourceTokenId,
      resolvedAtMs,
    );
    if (oppositeTokenId)
      this.pressure.resolveSource(
        oppositeTokenId,
        oppositeTokenId === unboundedSourceTokenId,
        resolvedAtMs,
      );
  }

  draw(): void {
    const tuning = getAgeStripTuning();
    const rowOrientation = this.host.getRowOrientation();

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
          oppositeTokenId: this.host.getOppositeTokenId(tokenId),
          centerY: raster.centerCss,
          topY: raster.topCss,
          bottomY: raster.topCss + raster.heightCss,
        };
      }),
      canvasWidth: vp.l + vp.width + this.host.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.host.plotter.padding.b,
    };
    this.clock.setEnabled(true);
    this.clock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);

    const gpuRows: GpuPressureRow[] = [];

    for (const [index, label] of activeControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;
      const primaryMemory = this.pressure.memory(tokenId);
      const oppositeTokenId = this.host.getOppositeTokenId(tokenId);
      const oppositeMemory = oppositeTokenId
        ? this.pressure.memory(oppositeTokenId)
        : undefined;
      if (!primaryMemory && !oppositeMemory) continue;

      const y = rowCount - 1 - index;
      const rowGeometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
      const colorScale = this.host.getPressureColorScale(tokenId);
      gpuRows.push({
        key: tokenId,
        centerCss: rowGeometry.centerCss,
        heightCss: rowGeometry.heightCss,
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
                  this.pressure.renderExtents(tokenId),
                  this.pressure.renderExtentRevision(tokenId),
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
                  this.pressure.renderExtents(oppositeTokenId!),
                  this.pressure.renderExtentRevision(oppositeTokenId!),
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
    pressureLayer.render({
      rows: gpuRows,
      viewport: { l: vp.l, width: vp.width },
      cssWidth: this.host.plotter.width,
      cssHeight: this.host.plotter.height,
      dpr,
      volumePerCssPixel: tuning.volumePerCssPixel,
      ghostHalfLifeMs: tuning.ghostHalfLifeMs,
      opacityTimeMs: opacityReference(
        observationClock(this.host.client).readReference(),
      ),
      background: theme.bg,
    });

    drawAgeAxes(frame, rowCount, activeControls, (tokenId) =>
      this.host.getPressureColorScale(tokenId),
    );
  }

  prepareVolumeView(): void {
    this.pressureLayer?.setVisible(false);
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
    this.unsubscribeTuning();
    this.unsubscribeObservation();
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.clock.destroy();
    this.tooltip.destroy();
    this.pressureLayer?.destroy();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.host.getViewMode() !== "age" || !handleAgeStripTuningWheel(event))
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
    return !!tokenId && this.host.activeTokens.has(tokenId);
  }
}
