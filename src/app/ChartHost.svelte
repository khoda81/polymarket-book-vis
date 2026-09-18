<script lang="ts">
  import { onMount } from "svelte";
  import {
    ChartController,
    type AutoHiddenReason,
    type ChartSurfaceElements,
  } from "../chart/controller";
  import {
    buildChartDefinition,
    type ChartMarketControl,
  } from "../lib/chartDefinition";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../lib/chartState";
  import type { EventBundle } from "../lib/eventBundle";
  import {
    initialMarketVisibility,
    isMarketVisible,
    loadUserHiddenMarketIds,
    partitionMarketVisibility,
    persistUserHiddenMarketIds,
    type MarketVisibility,
  } from "../lib/marketVisibility";
  import MarketControl from "./MarketControl.svelte";
  import { createPublicClient } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventBundle;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void =
    () => undefined;

  const definition = buildChartDefinition(bundle);
  const userHiddenMarketIds = loadUserHiddenMarketIds();

  let visibilityByMarketId = new Map<string, MarketVisibility>(
    definition.controls.map((control) => [
      control.marketId,
      initialMarketVisibility(
        control.acceptingOrders,
        userHiddenMarketIds.has(control.marketId),
      ),
    ]),
  );

  let canvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let toggles: HTMLDivElement;
  let hiddenTray: HTMLDivElement;
  let chart: ChartController | null = null;

  $: controlPartition = partitionMarketVisibility(
    definition.controls,
    visibilityByMarketId,
  );
  $: visibleControls = controlPartition.visible;
  $: hiddenControls = controlPartition.hidden;
  $: toggledControls =
    viewMode === "age" ? visibleControls : definition.controls;

  function visibility(control: ChartMarketControl): MarketVisibility {
    return (
      visibilityByMarketId.get(control.marketId) ??
      { kind: "visible" }
    );
  }

  function isVisible(control: ChartMarketControl): boolean {
    return isMarketVisible(visibility(control));
  }

  function setVisibility(
    marketId: string,
    next: MarketVisibility,
  ): void {
    visibilityByMarketId = new Map(visibilityByMarketId);
    visibilityByMarketId.set(marketId, next);
  }

  function userSetVisible(
    control: ChartMarketControl,
    visible: boolean,
  ): void {
    setVisibility(
      control.marketId,
      visible
        ? { kind: "visible" }
        : { kind: "hidden", reason: "user" },
    );

    if (visible) userHiddenMarketIds.delete(control.marketId);
    else userHiddenMarketIds.add(control.marketId);
    persistUserHiddenMarketIds(userHiddenMarketIds);

    chart?.setMarketVisible(control.marketId, visible);
  }

  function autoHide(
    marketId: string,
    reason: AutoHiddenReason,
  ): void {
    setVisibility(marketId, { kind: "hidden", reason });
  }

  function initialHiddenMarketIds(): Set<string> {
    return new Set(
      partitionMarketVisibility(
        definition.controls,
        visibilityByMarketId,
      ).hidden.map((control) => control.marketId),
    );
  }

  onMount(() => {
    let alive = true;
    const surface: ChartSurfaceElements = {
      canvas,
      canvasWrap,
      toggles,
      hiddenTray,
    };
    const next = new ChartController(surface, client, definition, {
      onConnectionStatus: (status) => {
        if (alive) onconnection(status);
      },
      onMarketAutoHidden: (marketId, reason) => {
        if (alive) autoHide(marketId, reason);
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
          onfailure(
            error instanceof Error ? error.message : String(error),
          );
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

<div class="cpv-canvas-wrap" bind:this={canvasWrap}>
  <canvas bind:this={canvas}></canvas>
</div>

<div class="cpv-toggles" bind:this={toggles}>
  {#each toggledControls as control (control.marketId)}
    <MarketControl
      {control}
      checked={isVisible(control)}
      onchange={(checked) => userSetVisible(control, checked)}
    />
  {/each}
</div>

<div
  class="cpv-hidden-markets"
  hidden={viewMode !== "age" || hiddenControls.length === 0}
  bind:this={hiddenTray}
>
  {#if viewMode === "age"}
    {#each hiddenControls as control (control.marketId)}
      <MarketControl
        {control}
        checked={false}
        onchange={(checked) => userSetVisible(control, checked)}
      />
    {/each}
  {/if}
</div>
