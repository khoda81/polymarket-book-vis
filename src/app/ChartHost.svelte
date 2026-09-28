<script lang="ts">
  import { onMount } from "svelte";
  import {
    ChartController,
    type ChartSurfaceElements,
  } from "../chart/controller";
  import {
    DEFAULT_AGE_ROW_ORIENTATION,
    type AgeRowOrientation,
  } from "../chart/ageStripOrientation";
  import {
    buildChartDefinition,
    type ChartMarketControl,
  } from "../lib/chartDefinition";
  import type { ConnectionStatus, ViewMode } from "../lib/chartState";
  import type { EventDetails } from "../lib/eventDetails";
  import {
    summarizeEventMarketStatus,
    type EventMarketStatus,
    type MarketLifecycle,
  } from "../lib/marketLifecycle";
  import {
    isMarketVisible,
    loadMarketVisibility,
    partitionMarketVisibility,
    persistStoredMarketVisibility,
    setMarketVisibility,
    setUserMarketVisible,
    storedVisibilityForUserChoice,
    type AutoHiddenReason,
    type MarketVisibility,
  } from "../lib/marketVisibility";
  import MarketControl from "./MarketControl.svelte";
  import { createPublicClient, type MarketId } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventDetails;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let ageRowOrientation: AgeRowOrientation = DEFAULT_AGE_ROW_ORIENTATION;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void = () => undefined;
  export let onmarketstatus: (status: EventMarketStatus) => void = () =>
    undefined;

  const definition = buildChartDefinition(bundle);
  const VISIBLE_MARKET: MarketVisibility = { kind: "visible" };

  let visibilityByMarketId = loadMarketVisibility(definition.controls);
  let lifecycleByMarketId = new Map<MarketId, MarketLifecycle>(
    definition.controls.map((control) => [
      control.market.id,
      control.lifecycle,
    ]),
  );

  let canvas: HTMLCanvasElement;
  let pressureCanvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let toggles: HTMLDivElement;
  let chart: ChartController | null = null;

  $: orderedAgeControls = [...definition.controls].sort(
    (a, b) => a.order - b.order,
  );
  $: controlPartition = partitionMarketVisibility(
    orderedAgeControls,
    visibilityByMarketId,
  );
  $: visibleControls = controlPartition.visible;
  $: hiddenControls = controlPartition.hidden;
  $: toggledControls =
    viewMode === "age" ? visibleControls : definition.controls;
  $: onmarketstatus(summarizeEventMarketStatus(lifecycleByMarketId.values()));

  function userSetVisible(control: ChartMarketControl, visible: boolean): void {
    visibilityByMarketId = setUserMarketVisible(
      visibilityByMarketId,
      control.market.id,
      visible,
    );

    const lifecycle =
      lifecycleByMarketId.get(control.market.id) ?? control.lifecycle;
    persistStoredMarketVisibility(
      control.market.id,
      storedVisibilityForUserChoice(visible, lifecycle),
    );
    chart?.setMarketVisible(control.market.id, visible);
  }

  function marketLifecycleChanged(
    marketId: MarketId,
    lifecycle: MarketLifecycle,
  ): void {
    lifecycleByMarketId = new Map(lifecycleByMarketId);
    lifecycleByMarketId.set(marketId, lifecycle);

    if (lifecycle.kind !== "resolved") return;

    const visibility = visibilityByMarketId.get(marketId) ?? VISIBLE_MARKET;
    if (visibility.kind !== "visible") return;

    visibilityByMarketId = setMarketVisibility(visibilityByMarketId, marketId, {
      kind: "hidden",
      reason: "resolved-default",
    });
    persistStoredMarketVisibility(marketId, "hidden-resolved");
    chart?.setMarketVisible(marketId, false);
  }

  function autoHide(marketId: MarketId, reason: AutoHiddenReason): void {
    visibilityByMarketId = setMarketVisibility(visibilityByMarketId, marketId, {
      kind: "hidden",
      reason,
    });
  }

  function initialHiddenMarketIds(): Set<MarketId> {
    return new Set(
      partitionMarketVisibility(
        definition.controls,
        visibilityByMarketId,
      ).hidden.map((control) => control.market.id),
    );
  }

  onMount(() => {
    let alive = true;
    const surface: ChartSurfaceElements = {
      canvas,
      pressureCanvas,
      canvasWrap,
      toggles,
    };
    const next = new ChartController(surface, client, definition, {
      onConnectionStatus: (status) => {
        if (alive) onconnection(status);
      },
      onMarketAutoHidden: (marketId, reason) => {
        if (alive) autoHide(marketId, reason);
      },
      onMarketLifecycleChanged: (marketId, lifecycle) => {
        if (alive) marketLifecycleChanged(marketId, lifecycle);
      },
    });
    chart = next;
    next.setViewMode(viewMode);
    next.setAgeRowOrientation(ageRowOrientation);

    void next.start(initialHiddenMarketIds()).then(
      () => {
        if (alive) onready();
      },
      (error: unknown) => {
        if (alive)
          onfailure(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      alive = false;
      chart = null;
      next.destroy();
    };
  });

  $: chart?.setViewMode(viewMode);
  $: chart?.setAgeRowOrientation(ageRowOrientation);
</script>

<div class="cpv-chart-stage">
  <div
    class="cpv-canvas-wrap"
    hidden={visibleControls.length === 0}
    bind:this={canvasWrap}
  >
    <canvas
      class="cpv-pressure-canvas"
      aria-hidden="true"
      bind:this={pressureCanvas}
    ></canvas>
    <canvas class="cpv-main-canvas" bind:this={canvas}></canvas>
  </div>

  <div
    class="cpv-toggles"
    class:cpv-toggles--age-axis={viewMode === "age"}
    hidden={viewMode === "age" && visibleControls.length === 0}
    bind:this={toggles}
  >
    {#each toggledControls as control (control.market.id)}
      <MarketControl
        {control}
        checked={isMarketVisible(
          visibilityByMarketId.get(control.market.id) ?? VISIBLE_MARKET,
        )}
        lifecycle={lifecycleByMarketId.get(control.market.id) ??
          control.lifecycle}
        onchange={(checked) => userSetVisible(control, checked)}
      />
    {/each}
  </div>
</div>

<div
  class="cpv-hidden-markets"
  hidden={viewMode !== "age" || hiddenControls.length === 0}
>
  {#if viewMode === "age"}
    {#each hiddenControls as control (control.market.id)}
      <MarketControl
        {control}
        checked={false}
        lifecycle={lifecycleByMarketId.get(control.market.id) ??
          control.lifecycle}
        onchange={(checked) => userSetVisible(control, checked)}
      />
    {/each}
  {/if}
</div>
