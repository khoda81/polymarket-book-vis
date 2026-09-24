<script lang="ts">
  import { onMount } from "svelte";
  import {
    ChartController,
    type ChartSurfaceElements,
  } from "../chart/controller";
  import {
    buildChartDefinition,
    type ChartMarketControl,
  } from "../lib/chartDefinition";
  import type { ConnectionStatus, ViewMode } from "../lib/chartState";
  import type { EventBundle } from "../lib/eventBundle";
  import {
    summarizeEventMarketStatus,
    type EventMarketStatus,
    type MarketLifecycle,
  } from "../lib/marketLifecycle";
  import {
    isMarketVisible,
    loadMarketVisibility,
    partitionMarketVisibility,
    persistUserVisibility,
    setMarketVisibility,
    setUserMarketVisible,
    type AutoHiddenReason,
    type MarketVisibility,
  } from "../lib/marketVisibility";
  import MarketControl from "./MarketControl.svelte";
  import { createPublicClient, type MarketId } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventBundle;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void = () => undefined;
  export let onmarketstatus: (status: EventMarketStatus) => void = () =>
    undefined;

  const definition = buildChartDefinition(bundle);
  const VISIBLE_MARKET: MarketVisibility = { kind: "visible" };

  let visibilityByMarketId = loadMarketVisibility(definition.controls);
  let lifecycleByMarketId = new Map<MarketId, MarketLifecycle>(
    definition.controls.map((control) => [control.market.id, control.lifecycle]),
  );

  let canvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let toggles: HTMLDivElement;
  let chart: ChartController | null = null;

  $: controlPartition = partitionMarketVisibility(
    definition.controls,
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
    persistUserVisibility(visibilityByMarketId);
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
</script>

<div class="cpv-chart-stage">
  <div
    class="cpv-canvas-wrap"
    hidden={visibleControls.length === 0}
    bind:this={canvasWrap}
  >
    <canvas bind:this={canvas}></canvas>
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
