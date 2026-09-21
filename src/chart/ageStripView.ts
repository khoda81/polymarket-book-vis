import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  ghostRefreshDelayMs,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import type { TokenBook } from "@/lib/orderBook";
import type { PressureCell } from "@/lib/pressureMemory";
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
} from "./ageStripLayout";
import {
  drawAgeAxes,
  drawPressureMemoryStrip,
  drawResolvedMarketStrip,
} from "./ageStripRendering";
import { AgeStripClock } from "./ageStripClock";
import { handleAgeStripTuningWheel } from "./ageStripInteraction";
import { AgeStripPressureState } from "./ageStripPressureState";
import type { LiveBookUpdate } from "./liveBookFeed";
import { AgeStripTooltip } from "./ageStripTooltip";
import type { ChartMarketControl } from "@/lib/chartDefinition";

export interface AgeStripHost {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
  readonly plotter: OrderBookPlotter;
  readonly activeTokens: Set<string>;
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenName: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
  readonly getTheme: () => ChartTheme;
  readonly getViewMode: () => "volume" | "age";
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
  private readonly visibilityInitialized = new Set<string>();
  private ghostRefreshTimer: number | undefined;
  private layoutMode: "age" | "volume" | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.clock = new AgeStripClock({
      canvasWrap: host.canvasWrap,
      getViewMode: host.getViewMode,
      getTheme: host.getTheme,
      getTiming: (tokenId) => this.pressure.timing(tokenId),
    });
    this.tooltip = new AgeStripTooltip({
      canvas: host.canvas,
      getViewMode: host.getViewMode,
      getBook: host.getBook,
      getTokenName: host.getTokenName,
      getOppositeTokenName: host.getOppositeTokenName,
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
    this.visibilityInitialized.clear();
    this.cancelGhostRefresh();
    this.clock.reset();
    this.tooltip.clear();
    this.layoutMode = null;
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    this.pressure.setRecordingCoverage(recordingSinceMsByToken);
    this.clock.refresh();
  }

  hydratePressureMemory(
    cellsByToken: Readonly<Record<string, readonly PressureCell[]>>,
  ): void {
    this.pressure.hydrate(cellsByToken, (tokenId) =>
      this.host.getBook(tokenId),
    );
  }

  configureMarkets(controls: readonly ChartMarketControl[]): void {
    this.visibilityInitialized.clear();
    this.pressure.configure(
      controls.map((control) => ({
        tokenId: String(control.tokenId),
        resolutionMs: control.resolutionMs,
      })),
    );
  }

  onBookUpdate(tokenId: string, update: LiveBookUpdate): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    this.pressure.applyBookUpdate(tokenId, book, update);

    if (this.visibilityInitialized.has(tokenId)) return;
    this.visibilityInitialized.add(tokenId);
    if (hasRealOrders(book)) return;

    if (this.host.activeTokens.has(tokenId)) this.host.hideToken(tokenId);
  }

  resolveMarket(tokenId: string): void {
    this.pressure.resolve(tokenId);
  }

  draw(): void {
    // A book-driven redraw already advances the ghosts. Reset the decay timer
    // so a ghost-only frame happens only after the chart has gone quiet.
    this.cancelGhostRefresh();

    const tuning = getAgeStripTuning();
    const nowMs = Date.now();
    let hasVisibleGhosts = false;

    const controls = this.collectControls();
    const activeControls = controls.filter((label) => this.isActive(label));
    const rowCount = Math.max(1, activeControls.length);

    this.installAgeLayout(rowCount, activeControls);

    const frame = this.host.plotter.beginFrame(this.host.getTheme(), {
      xRange: { min: 0, max: 1 },
      yRange: { min: -0.5, max: rowCount - 0.5 },
    });
    positionRowControls(activeControls, frame, rowCount);

    const vp = frame.viewport;
    const geometry: AgeStripGeometry = {
      viewport: {
        l: vp.l,
        t: vp.t,
        width: vp.width,
        height: vp.height,
      },
      rows: activeControls.map((label, index) => {
        const tokenId = label.dataset.tokenId ?? `missing-row-${index}`;
        const side = label.dataset.ageResolutionSide;
        const resolution =
          side === "primary" || side === "opposite"
            ? {
                side: side as "primary" | "opposite",
                outcome: label.dataset.ageResolutionOutcome ?? "",
                marketEndMs:
                  this.pressure.timing(tokenId)?.resolutionMs ?? null,
              }
            : undefined;

        return { tokenId, resolution };
      }),
      canvasWidth: vp.l + vp.width + this.host.plotter.padding.r,
      canvasHeight: vp.t + vp.height + this.host.plotter.padding.b,
    };
    this.clock.setEnabled(true);
    this.clock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);

    for (const [index, label] of activeControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;
      const cells = this.pressure.cells(tokenId);

      const resolutionSide = label.dataset.ageResolutionSide;
      if (resolutionSide === "primary" || resolutionSide === "opposite") {
        drawResolvedMarketStrip(
          frame,
          rowCount - 1 - index,
          resolutionSide,
          label.dataset.ageResolutionOutcome ?? "",
          this.host.getPressureColorScale(tokenId),
        );
        continue;
      }

      const y = rowCount - 1 - index;
      drawPressureMemoryStrip(
        frame,
        y,
        cells,
        this.host.getPressureColorScale(tokenId),
        tuning.volumePerCssPixel,
        tuning.ghostHalfLifeMs,
        nowMs,
      );
      hasVisibleGhosts ||= this.pressure.hasVisibleGhosts(
        tokenId,
        nowMs,
        tuning.ghostHalfLifeMs,
      );
    }

    drawAgeAxes(frame, rowCount, activeControls, (tokenId) =>
      this.host.getPressureColorScale(tokenId),
    );

    if (hasVisibleGhosts)
      this.scheduleGhostRefresh(ghostRefreshDelayMs(tuning.ghostHalfLifeMs));
  }

  prepareVolumeView(): void {
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
    this.cancelGhostRefresh();
    this.host.canvas.removeEventListener("wheel", this.handleWheel, true);
    this.clock.destroy();
    this.tooltip.destroy();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (this.host.getViewMode() !== "age" || !handleAgeStripTuningWheel(event))
      return;

    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private scheduleGhostRefresh(delayMs: number): void {
    if (
      this.ghostRefreshTimer !== undefined ||
      this.host.getViewMode() !== "age"
    )
      return;

    this.ghostRefreshTimer = window.setTimeout(() => {
      this.ghostRefreshTimer = undefined;
      this.host.requestDraw();
    }, delayMs);
  }

  private cancelGhostRefresh(): void {
    if (this.ghostRefreshTimer === undefined) return;
    clearTimeout(this.ghostRefreshTimer);
    this.ghostRefreshTimer = undefined;
  }

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
