import {
  AGE_ROW_BAND_PX,
  getAgeStripTuning,
  scaleAgeStripGhostHalfLife,
  scaleAgeStripVolumePerCssPixel,
  subscribeAgeStripTuning,
} from "@/lib/ageStripTuning";
import type { TokenBook } from "@/lib/orderBook";
import {
  PressureMemory,
  type PressureCell,
} from "@/lib/pressureMemory";
import { signedVolumeSegments } from "@/lib/signedVolume";
import type { ChartTheme, OrderBookPlotter } from "@/lib/renderer";
import type { SignedVolumeColorScale } from "@/lib/signedVolume";
import {
  AGE_TIME_GUTTER_PX,
  type AgeStripGeometry,
  VOLUME_LEFT_PADDING_PX,
  VOLUME_RIGHT_PADDING_PX,
  ageLabelGutterWidth,
  hasRealOrders,
  normalizedWheelDelta,
  positionRowControls,
} from "./ageStripLayout";
import {
  drawAgeAxes,
  drawPressureMemoryStrip,
  drawResolvedMarketStrip,
} from "./ageStripRendering";
import { AgeStripClock } from "./ageStripClock";
import { AgeStripTooltip } from "./ageStripTooltip";
import type { ChartMarketControl } from "@/lib/chartDefinition";

interface MarketRuntimeState {
  visibilityInitialized: boolean;
  recordingSinceMs: number | null;
  resolutionMs: number | null;
  readonly pressureMemory: PressureMemory;
}

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
 * Age-mode projection of the live order books.
 *
 * Performance benchmark path: render the authoritative live book directly into
 * the visible Canvas2D surface. There is no WebGL texture construction, upload,
 * offscreen presentation, canvas copy, or historical rendering in this branch.
 */
export class AgeStripView {
  private readonly host: AgeStripHost;
  private readonly clock: AgeStripClock;
  private readonly tooltip: AgeStripTooltip;
  private readonly unsubscribeTuning: () => void;
  private readonly markets = new Map<string, MarketRuntimeState>();
  private ghostRefreshTimer: number | undefined;
  private layoutMode: "age" | "volume" | null = null;

  constructor(host: AgeStripHost) {
    this.host = host;
    this.clock = new AgeStripClock({
      canvasWrap: host.canvasWrap,
      getViewMode: host.getViewMode,
      getTheme: host.getTheme,
      getTiming: (tokenId) => this.markets.get(tokenId),
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
    this.markets.clear();
    this.cancelGhostRefresh();
    this.clock.reset();
    this.tooltip.clear();
    this.layoutMode = null;
  }

  setRecordingCoverage(
    recordingSinceMsByToken: Readonly<Record<string, number>>,
  ): void {
    for (const [tokenId, since] of Object.entries(recordingSinceMsByToken)) {
      let state = this.markets.get(tokenId);
      if (!state) {
        state = {
          visibilityInitialized: false,
          recordingSinceMs: null,
          resolutionMs: null,
          pressureMemory: new PressureMemory(),
        };
        this.markets.set(tokenId, state);
      }
      state.recordingSinceMs =
        Number.isFinite(since) && since >= 0 ? since : null;
    }
    this.clock.refresh();
  }

  hydratePressureMemory(
    cellsByToken: Readonly<
      Record<string, readonly PressureCell[]>
    >,
  ): void {
    const nowMs = Date.now();
    for (const [tokenId, cells] of Object.entries(cellsByToken)) {
      let state = this.markets.get(tokenId);
      if (!state) {
        state = {
          visibilityInitialized: false,
          recordingSinceMs: null,
          resolutionMs: null,
          pressureMemory: new PressureMemory(),
        };
        this.markets.set(tokenId, state);
      }

      state.pressureMemory.restore(cells);

      // A live websocket snapshot may have beaten recorder hydration. Repaint
      // it last so current liquidity always dominates persisted ghosts.
      const book = this.host.getBook(tokenId);
      if (book)
        state.pressureMemory.observe(
          signedVolumeSegments(book),
          nowMs,
        );

      if (state.pressureMemory.hasGhosts())
        this.scheduleGhostRefresh();
    }
  }

  configureMarkets(
    controls: readonly ChartMarketControl[],
  ): void {
    this.markets.clear();
    for (const control of controls) {
      this.markets.set(String(control.tokenId), {
        visibilityInitialized: false,
        recordingSinceMs: null,
        resolutionMs: control.resolutionMs,
        pressureMemory: new PressureMemory(),
      });
    }
  }

  onBookUpdate(tokenId: string): void {
    const book = this.host.getBook(tokenId);
    if (!book) return;

    let state = this.markets.get(tokenId);
    if (!state) {
      state = {
        visibilityInitialized: false,
        recordingSinceMs: null,
        resolutionMs: null,
        pressureMemory: new PressureMemory(),
      };
      this.markets.set(tokenId, state);
    }

    state.pressureMemory.observe(
      signedVolumeSegments(book),
      Date.now(),
    );
    this.scheduleGhostRefresh();

    if (state.visibilityInitialized) return;
    state.visibilityInitialized = true;
    if (hasRealOrders(book)) return;

    if (this.host.activeTokens.has(tokenId))
      this.host.hideToken(tokenId);
  }

  resolveMarket(tokenId: string): void {
    const state = this.markets.get(tokenId);
    if (!state) return;

    state.pressureMemory.observe(
      [{ lo: 0, hi: 1, volume: 0 }],
      Date.now(),
    );
    this.scheduleGhostRefresh();
  }

  draw(): void {
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
      rows: activeControls.map((label, index) => ({
        tokenId:
          label.dataset.tokenId ?? `missing-row-${index}`,
      })),
      canvasWidth:
        vp.l + vp.width + this.host.plotter.padding.r,
      canvasHeight:
        vp.t + vp.height + this.host.plotter.padding.b,
    };
    this.clock.setEnabled(true);
    this.clock.setGeometry(geometry);
    this.tooltip.setGeometry(geometry);

    for (const [index, label] of activeControls.entries()) {
      const tokenId = label.dataset.tokenId;
      if (!tokenId) continue;
      const state = this.markets.get(tokenId);
      if (!state) continue;

      const tuning = getAgeStripTuning();
      const nowMs = Date.now();
      const resolutionSide =
        label.dataset.ageResolutionSide;
      if (
        resolutionSide === "primary" ||
        resolutionSide === "opposite"
      )
        drawResolvedMarketStrip(
          frame,
          rowCount - 1 - index,
          resolutionSide,
          this.host.getPressureColorScale(tokenId),
        );

      state.pressureMemory.prune(
        nowMs,
        tuning.ghostHalfLifeMs,
      );

      const y = rowCount - 1 - index;
      drawPressureMemoryStrip(
        frame,
        y,
        state.pressureMemory.snapshot(),
        this.host.getPressureColorScale(tokenId),
        tuning.volumePerCssPixel,
        tuning.ghostHalfLifeMs,
        nowMs,
      );
      if (state.pressureMemory.hasGhosts())
        this.scheduleGhostRefresh();
    }

    drawAgeAxes(
      frame,
      rowCount,
      activeControls,
      (tokenId) => this.host.getPressureColorScale(tokenId),
    );
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
    this.host.canvas.removeEventListener(
      "wheel",
      this.handleWheel,
      true,
    );
    this.clock.destroy();
    this.tooltip.destroy();
  }

  private readonly handleWheel = (event: WheelEvent) => {
    if (
      this.host.getViewMode() !== "age" ||
      (!event.ctrlKey && !event.shiftKey)
    )
      return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const factor = Math.exp(
      normalizedWheelDelta(event) * 0.002,
    );
    if (event.shiftKey)
      scaleAgeStripGhostHalfLife(factor);
    else scaleAgeStripVolumePerCssPixel(factor);
  };

  private scheduleGhostRefresh(): void {
    if (
      this.ghostRefreshTimer !== undefined ||
      this.host.getViewMode() !== "age"
    )
      return;

    this.ghostRefreshTimer = window.setTimeout(() => {
      this.ghostRefreshTimer = undefined;
      this.host.requestDraw();
    }, 33);
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
        Number(a.dataset.marketOrder ?? 0) -
        Number(b.dataset.marketOrder ?? 0),
    );
  }

  private isActive(label: HTMLLabelElement): boolean {
    const tokenId = label.dataset.tokenId;
    return !!tokenId && this.host.activeTokens.has(tokenId);
  }



}
