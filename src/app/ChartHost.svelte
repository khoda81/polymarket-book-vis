<script lang="ts">
  import { onMount } from "svelte";
  import {
    ChartController,
    type ChartSurfaceElements,
  } from "../chart/controller";
  import {
    buildChartDefinition,
    type ChartDefinition,
  } from "../lib/chartDefinition";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../lib/chartState";
  import type { EventBundle } from "../lib/eventBundle";
  import { createPublicClient } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventBundle;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void =
    () => undefined;

  let canvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let toggles: HTMLDivElement;
  let chart: ChartController | null = null;

  $: definition = buildChartDefinition(bundle);

  function hideBrokenIcon(event: Event): void {
    const target = event.currentTarget;
    if (target instanceof HTMLImageElement) target.remove();
  }

  onMount(() => {
    let alive = true;
    const surface: ChartSurfaceElements = {
      canvas,
      canvasWrap,
      toggles,
    };
    const next = new ChartController(surface, client, {
      onConnectionStatus: (status) => {
        if (alive) onconnection(status);
      },
    });
    chart = next;
    next.setViewMode(viewMode);

    void next.load(definition).then(
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
  {#each definition.controls as control (control.marketId)}
    <label
      data-token-id={control.tokenId}
      data-market-id={control.marketId}
      title={control.title}
    >
      <input type="checkbox" checked />
      <span
        class="cpv-market-dot"
        style:background={control.dotColor}
        aria-hidden="true"
      ></span>
      {#if control.iconUrl}
        <img
          class="cpv-market-icon"
          src={control.iconUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          onerror={hideBrokenIcon}
        />
      {/if}
      <span class="cpv-market-label-text">{control.title}</span>
    </label>
  {/each}
</div>
