import { fetchRecorderHydration } from "@/lib/ageRecorderClient";
import type { ConnectionStatus, ViewMode } from "@/lib/chartState";
import type { AutoHiddenReason } from "@/lib/marketVisibility";
import {
  resolveMarketLifecycle,
  type MarketLifecycle,
  type MarketResolutionUpdate,
} from "@/lib/marketLifecycle";
import {
  pressureScaleForToken,
  type ChartDefinition,
} from "@/lib/chartDefinition";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import {
  ChartTheme,
  OrderBookPlotter,
} from "@/lib/renderer";
import { AgeStripView } from "./ageStripView";
import { LiveBookFeed } from "./liveBookFeed";
import { VolumeBookView } from "./volumeBookView";
import {
  TokenId,
  PublicClient,
} from "@polymarket/client";

const LIGHT_THEME: ChartTheme = {
  bg: "#ffffff",
  grid: "rgba(128,128,128,0.15)",
  axis: "rgba(128,128,128,0.5)",
  text: "#666666",
};

const DARK_THEME: ChartTheme = {
  bg: "#121212",
  grid: "rgba(255,255,255,0.1)",
  axis: "rgba(255,255,255,0.3)",
  text: "#aaaaaa",
};

export interface ChartSurfaceElements {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
}

export interface ChartControllerOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onMarketAutoHidden?: (
    marketId: string,
    reason: AutoHiddenReason,
  ) => void;
  readonly onMarketLifecycleChanged?: (
    marketId: string,
    lifecycle: MarketLifecycle,
  ) => void;
}

export class ChartController {
  private readonly feed: LiveBookFeed;
  private readonly onMarketAutoHidden: (
    marketId: string,
    reason: AutoHiddenReason,
  ) => void;
  private readonly onMarketLifecycleChanged: (
    marketId: string,
    lifecycle: MarketLifecycle,
  ) => void;
  private readonly lifecycleByMarketId = new Map<
    string,
    MarketLifecycle
  >();
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly activeTokens = new Set<TokenId>();

  private theme: ChartTheme;
  private plotter!: OrderBookPlotter;
  private ageView!: AgeStripView;
  private volumeView!: VolumeBookView;
  private raf: number | null = null;
  private readonly definition: ChartDefinition;
  private viewMode: ViewMode = "age";
  private lifecycle: "new" | "started" | "destroyed" = "new";

  constructor(
    surface: ChartSurfaceElements,
    polyMarketClient: PublicClient,
    definition: ChartDefinition,
    options: ChartControllerOptions = {},
  ) {
    this.definition = definition;
    this.onMarketAutoHidden =
      options.onMarketAutoHidden ?? (() => undefined);
    this.onMarketLifecycleChanged =
      options.onMarketLifecycleChanged ?? (() => undefined);
    for (const control of definition.controls)
      this.lifecycleByMarketId.set(
        control.marketId,
        control.lifecycle,
      );

    this.feed = new LiveBookFeed(polyMarketClient, {
      onConnectionStatus:
        options.onConnectionStatus ?? (() => undefined),
      onBookUpdated: (tokenId) => {
        this.ageView.onBookUpdate(tokenId);
        this.reqDraw();
      },
      onMarketResolved: (resolution) => {
        this.applyResolution(resolution);
      },
    });

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = this.themeQuery.matches ? DARK_THEME : LIGHT_THEME;

    this.plotter = new OrderBookPlotter(surface.canvas);

    this.ageView = new AgeStripView({
      canvas: surface.canvas,
      canvasWrap: surface.canvasWrap,
      toggles: surface.toggles,
      plotter: this.plotter,
      activeTokens: this.activeTokens,
      getBook: (tokenId) => this.feed.getBook(tokenId),
      getTokenName: (tokenId) =>
        this.definition.tokenNames.get(String(tokenId)),
      getOppositeTokenName: (tokenId) =>
        this.definition.oppositeTokenNames.get(String(tokenId)),
      getPressureColorScale: (tokenId) =>
        this.pressureColorScale(tokenId as TokenId),
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      hideToken: (tokenId) =>
        this.autoHideToken(tokenId as TokenId, "empty-book"),
      requestDraw: () => this.reqDraw(),
    });

    this.volumeView = new VolumeBookView({
      plotter: this.plotter,
      definition: this.definition,
      activeTokens: this.activeTokens,
      getBook: (tokenId) => this.feed.getBook(tokenId),
      getTheme: () => this.theme,
      isActive: () => this.viewMode === "volume",
      requestDraw: () => this.reqDraw(),
    });
    this.plotter.onZoom = (delta) =>
      this.volumeView.zoom(delta);
    this.plotter.onPointer = (pointer) =>
      this.volumeView.setPointer(pointer);

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.plotter.resizeTo(entry.contentRect.width, entry.contentRect.height);
      this.reqDraw();
    });
    this.resizeObserver.observe(surface.canvas);
    this.themeQuery.addEventListener("change", this.handleThemeChange);
  }

  private handleThemeChange = (event: MediaQueryListEvent) => {
    this.theme = event.matches ? DARK_THEME : LIGHT_THEME;
    this.reqDraw();
  };

  async start(
    hiddenMarketIds: ReadonlySet<string>,
  ): Promise<void> {
    if (this.lifecycle !== "new")
      throw new Error(
        `ChartController cannot start from ${this.lifecycle}`,
      );
    this.lifecycle = "started";

    const { event } = this.definition;
    const tokenIds = this.definition.controls.map(
      (control) => control.tokenId,
    );

    for (const control of this.definition.controls)
      if (!hiddenMarketIds.has(control.marketId))
        this.activeTokens.add(control.tokenId);

    this.ageView.configureMarkets(this.definition.controls);

    // Recorder registration/metadata is optional and must never gate the live
    // websocket.
    void fetchRecorderHydration(tokenIds).then((hydration) => {
      if (this.lifecycle === "destroyed") return;
      this.ageView.setRecordingCoverage(
        hydration.recordingSinceMsByToken,
      );
      this.ageView.hydratePressureMemory(
        hydration.pressureCellsByToken,
      );
      this.reqDraw();
    });

    await this.feed.start(tokenIds);
    if (this.lifecycle === "started") this.reqDraw();
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.reqDraw();
  }

  setMarketVisible(marketId: string, visible: boolean): void {
    const control = this.definition.controls.find(
      (candidate) => candidate.marketId === marketId,
    );
    if (!control) return;

    if (visible) this.activeTokens.add(control.tokenId);
    else this.activeTokens.delete(control.tokenId);
    this.reqDraw();
  }

  destroy() {
    if (this.lifecycle === "destroyed") return;
    this.lifecycle = "destroyed";
    this.feed.destroy();
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.ageView.destroy();
    this.plotter.destroy();
    this.resizeObserver.disconnect();
    this.themeQuery.removeEventListener("change", this.handleThemeChange);
  }

  private pressureColorScale(tokenId: TokenId): SignedVolumeColorScale {
    return pressureScaleForToken(this.definition, String(tokenId));
  }

  private autoHideToken(
    tokenId: TokenId,
    reason: AutoHiddenReason,
  ): void {
    const control = this.definition.controls.find(
      (candidate) => candidate.tokenId === tokenId,
    );
    if (!control) return;

    const lifecycle = this.lifecycleByMarketId.get(control.marketId);
    if (lifecycle && lifecycle.kind !== "live") return;

    if (!this.activeTokens.delete(tokenId)) return;
    this.onMarketAutoHidden(control.marketId, reason);
    this.reqDraw();
  }

  private applyResolution(
    resolution: MarketResolutionUpdate,
  ): void {
    for (const control of this.definition.controls) {
      const belongsToMarket =
        (control.conditionId !== null &&
          control.conditionId === resolution.conditionId) ||
        resolution.assetIds.includes(String(control.tokenId)) ||
        (control.oppositeTokenId !== null &&
          resolution.assetIds.includes(
            String(control.oppositeTokenId),
          )) ||
        resolution.winningTokenId === String(control.tokenId) ||
        (control.oppositeTokenId !== null &&
          resolution.winningTokenId ===
            String(control.oppositeTokenId));
      if (!belongsToMarket) continue;

      const current =
        this.lifecycleByMarketId.get(control.marketId) ??
        control.lifecycle;
      const next = resolveMarketLifecycle(
        current,
        resolution,
        control.tokenId,
        control.oppositeTokenId,
        control.primaryOutcome,
        control.oppositeOutcome,
      );
      if (next === current) continue;

      this.lifecycleByMarketId.set(control.marketId, next);
      this.activeTokens.add(control.tokenId);
      this.ageView.resolveMarket(String(control.tokenId));
      this.onMarketLifecycleChanged(control.marketId, next);
    }
    this.reqDraw();
  }

  private reqDraw() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw() {
    this.raf = null;
    this.ageView.flushBookUpdates();
    if (this.viewMode === "age") {
      this.ageView.draw();
      return;
    }

    this.ageView.prepareVolumeView();
    this.volumeView.draw();
  }



}
