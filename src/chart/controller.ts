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
  type ChartMarketControl,
} from "@/lib/chartDefinition";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import { OrderBookPlotter, type ChartTheme } from "@/lib/renderer";
import { chartThemeForDarkMode } from "./chartTheme";
import { AgeStripView } from "./ageStripView";
import { LiveBookFeed } from "./liveBookFeed";
import { VolumeBookView } from "./volumeBookView";
import type { MarketId, PublicClient, TokenId } from "@polymarket/client";

export interface ChartSurfaceElements {
  readonly canvas: HTMLCanvasElement;
  readonly canvasWrap: HTMLElement;
  readonly toggles: HTMLElement;
}

export interface ChartControllerOptions {
  readonly onConnectionStatus?: (status: ConnectionStatus) => void;
  readonly onMarketAutoHidden?: (
    marketId: MarketId,
    reason: AutoHiddenReason,
  ) => void;
  readonly onMarketLifecycleChanged?: (
    marketId: MarketId,
    lifecycle: MarketLifecycle,
  ) => void;
}

export class ChartController {
  private readonly feed: LiveBookFeed;
  private readonly onMarketAutoHidden: (
    marketId: MarketId,
    reason: AutoHiddenReason,
  ) => void;
  private readonly onMarketLifecycleChanged: (
    marketId: MarketId,
    lifecycle: MarketLifecycle,
  ) => void;
  private readonly lifecycleByMarketId = new Map<MarketId, MarketLifecycle>();
  private readonly themeQuery: MediaQueryList;
  private readonly resizeObserver: ResizeObserver;
  private readonly activeTokens = new Set<TokenId>();
  private readonly controlByTokenValue = new Map<string, ChartMarketControl>();

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
    this.onMarketAutoHidden = options.onMarketAutoHidden ?? (() => undefined);
    this.onMarketLifecycleChanged =
      options.onMarketLifecycleChanged ?? (() => undefined);
    for (const control of definition.controls) {
      this.lifecycleByMarketId.set(control.market.id, control.lifecycle);
      this.controlByTokenValue.set(control.tokenId, control);
    }

    this.feed = new LiveBookFeed(polyMarketClient, {
      onConnectionStatus: options.onConnectionStatus ?? (() => undefined),
      onBookUpdated: (tokenId, _book, update) => {
        this.ageView.onBookUpdate(tokenId, update);
        this.reqDraw();
      },
      onMarketResolved: (resolution) => {
        this.applyResolution(resolution);
      },
    });

    this.themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    this.theme = chartThemeForDarkMode(this.themeQuery.matches);

    this.plotter = new OrderBookPlotter(surface.canvas);

    this.ageView = new AgeStripView({
      canvas: surface.canvas,
      canvasWrap: surface.canvasWrap,
      toggles: surface.toggles,
      plotter: this.plotter,
      activeTokens: this.activeTokens,
      getBook: (tokenId) => {
        const id = this.knownTokenId(tokenId);
        return id ? this.feed.getBook(id) : undefined;
      },
      getTokenName: (tokenId) => {
        const control = this.controlForTokenValue(tokenId);
        return control?.market.outcomes.yes.label;
      },
      getOppositeTokenName: (tokenId) => {
        const control = this.controlForTokenValue(tokenId);
        return control?.market.outcomes.no.label;
      },
      getPressureColorScale: (tokenId) => {
        const id = this.knownTokenId(tokenId);
        return id
          ? this.pressureColorScale(id)
          : DEFAULT_SIGNED_VOLUME_COLOR_SCALE;
      },
      getTheme: () => this.theme,
      getViewMode: () => this.viewMode,
      hideToken: (tokenId) => {
        const id = this.knownTokenId(tokenId);
        if (id) this.autoHideToken(id, "empty-book");
      },
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
    this.plotter.onZoom = (delta) => this.volumeView.zoom(delta);
    this.plotter.onPointer = (pointer) => this.volumeView.setPointer(pointer);

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
    this.theme = chartThemeForDarkMode(event.matches);
    this.reqDraw();
  };

  async start(hiddenMarketIds: ReadonlySet<MarketId>): Promise<void> {
    if (this.lifecycle !== "new")
      throw new Error(`ChartController cannot start from ${this.lifecycle}`);
    this.lifecycle = "started";

    const unresolvedControls = this.definition.controls.filter(
      (control) => control.lifecycle.kind !== "resolved",
    );
    const tokenIds = unresolvedControls.map((control) => control.tokenId);

    for (const control of this.definition.controls)
      if (!hiddenMarketIds.has(control.market.id))
        this.activeTokens.add(control.tokenId);

    this.ageView.configureMarkets(this.definition.controls);

    // Resolved rows have their own semantic rendering and tooltip; pulling
    // their historical pressure into the browser only wastes memory/CPU.
    if (tokenIds.length > 0) {
      // Recorder registration/metadata is optional and must never gate the live
      // websocket.
      void fetchRecorderHydration(tokenIds).then((hydration) => {
        if (this.lifecycle === "destroyed") return;
        this.ageView.setRecordingCoverage(hydration.recordingSinceMsByToken);
        this.ageView.hydratePressureMemory(hydration.pressureSnapshotsByToken);
        this.reqDraw();
      });

      await this.feed.start(tokenIds);
    }
    if (this.lifecycle === "started") this.reqDraw();
  }

  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    this.reqDraw();
  }

  setMarketVisible(marketId: MarketId, visible: boolean): void {
    const control = this.definition.controls.find(
      (candidate) => candidate.market.id === marketId,
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

  private knownTokenId(value: string): TokenId | null {
    return this.controlByTokenValue.get(value)?.tokenId ?? null;
  }

  private controlForTokenValue(value: string): ChartMarketControl | undefined {
    return this.controlByTokenValue.get(value);
  }

  private pressureColorScale(tokenId: TokenId): SignedVolumeColorScale {
    return pressureScaleForToken(this.definition, tokenId);
  }

  private autoHideToken(tokenId: TokenId, reason: AutoHiddenReason): void {
    const control = this.definition.controls.find(
      (candidate) => candidate.tokenId === tokenId,
    );
    if (!control) return;

    const lifecycle = this.lifecycleByMarketId.get(control.market.id);
    if (lifecycle && lifecycle.kind !== "live") return;

    if (!this.activeTokens.delete(tokenId)) return;
    this.onMarketAutoHidden(control.market.id, reason);
    this.reqDraw();
  }

  private applyResolution(resolution: MarketResolutionUpdate): void {
    for (const control of this.definition.controls) {
      const oppositeTokenId = control.market.outcomes.no.tokenId;
      const belongsToMarket =
        (control.market.conditionId !== null &&
          control.market.conditionId === resolution.conditionId) ||
        resolution.assetIds.includes(control.tokenId) ||
        (oppositeTokenId !== null &&
          resolution.assetIds.includes(oppositeTokenId)) ||
        resolution.winningAssetId === control.tokenId ||
        (oppositeTokenId !== null &&
          resolution.winningAssetId === oppositeTokenId);
      if (!belongsToMarket) continue;

      const current =
        this.lifecycleByMarketId.get(control.market.id) ?? control.lifecycle;
      const next = resolveMarketLifecycle(
        current,
        resolution,
        control.tokenId,
        oppositeTokenId,
        control.market.outcomes.yes.label,
        control.market.outcomes.no.label,
      );
      if (next === current) continue;

      this.lifecycleByMarketId.set(control.market.id, next);
      this.activeTokens.add(control.tokenId);
      this.ageView.resolveMarket(String(control.tokenId));
      this.onMarketLifecycleChanged(control.market.id, next);
    }
    this.reqDraw();
  }

  private reqDraw() {
    if (this.raf !== null) return;
    this.raf = requestAnimationFrame(() => this.performDraw());
  }

  private performDraw() {
    this.raf = null;
    if (this.viewMode === "age") {
      this.ageView.draw();
      return;
    }

    this.ageView.prepareVolumeView();
    this.volumeView.draw();
  }
}
