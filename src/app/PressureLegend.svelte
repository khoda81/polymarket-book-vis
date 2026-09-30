<script lang="ts">
  import { onMount } from "svelte";
  import {
    AGE_ROW_BAND_PX,
    getAgeStripTuning,
    subscribeAgeStripTuning,
    type AgeStripTuning,
  } from "../lib/ageStripTuning";
  import { GhostMemoryScale } from "../chart/ghostMemoryScale";
  import type { PublicClient } from "@polymarket/client";
  import { shareLegendTicks } from "../lib/shareLegendTicks";
  import {
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    signedVolumeColor,
  } from "../lib/signedVolume";

  export let client: PublicClient;

  const SHARE_TICK_MIN_DISTANCE_PX = 24;
  let shareBar: HTMLDivElement;
  let ghostCanvas: HTMLCanvasElement;
  let ghostLatency: HTMLSpanElement;
  let shareWidth = 0;
  let tuning: Readonly<AgeStripTuning> = getAgeStripTuning();

  $: reserveShares = tuning.volumePerCssPixel * AGE_ROW_BAND_PX;
  $: shareTicks = shareLegendTicks(reserveShares, shareWidth, {
    minDistancePx: SHARE_TICK_MIN_DISTANCE_PX,
  });
  $: negativeColor = signedVolumeColor(-1, DEFAULT_SIGNED_VOLUME_COLOR_SCALE);
  $: positiveColor = signedVolumeColor(1, DEFAULT_SIGNED_VOLUME_COLOR_SCALE);

  onMount(() => {
    const unsubscribe = subscribeAgeStripTuning((next) => {
      tuning = next;
    });
    const observer = new ResizeObserver(() => {
      shareWidth = shareBar.clientWidth;
    });
    observer.observe(shareBar);
    shareWidth = shareBar.clientWidth;

    const ghost = new GhostMemoryScale(ghostCanvas, ghostLatency, client);

    return () => {
      ghost.destroy();
      observer.disconnect();
      unsubscribe();
    };
  });
</script>

<div class="pressure-legends" aria-label="Pressure scales">
  <section
    class="volume-legend"
    aria-label="Global signed-share pressure scale"
    title="Ctrl+wheel adjusts share pressure"
  >
    <div class="volume-legend-header">
      <span>Share pressure</span>
    </div>
    <div
      class="volume-legend-bar"
      bind:this={shareBar}
      aria-hidden="true"
      style:--negative-pressure-color={negativeColor}
      style:--positive-pressure-color={positiveColor}
    >
      <span class="volume-legend-wedge volume-legend-wedge--negative"></span>
      <span class="volume-legend-wedge volume-legend-wedge--positive"></span>
      {#each shareTicks as tick (tick.value)}
        <span
          class="volume-legend-mark"
          style:left={`${tick.position * 100}%`}
          style:opacity={tick.opacity}
        ></span>
      {/each}
    </div>
    <div class="volume-legend-ticks">
      {#each shareTicks as tick (tick.value)}
        <span
          style:left={`${tick.position * 100}%`}
          style:opacity={tick.opacity}
        >
          {tick.label}
        </span>
      {/each}
    </div>
  </section>

  <section class="ghost-legend" aria-label="Ghost memory scale">
    <div class="ghost-legend-header">
      <span>Ghost memory</span>
      <span class="ghost-legend-note">newest → older</span>
    </div>
    <div class="ghost-memory-scale">
      <canvas
        class="ghost-memory-canvas"
        bind:this={ghostCanvas}
        role="img"
        aria-label="Ghost memory: awaiting observation"
      ></canvas>
      <span
        class="ghost-memory-latency"
        bind:this={ghostLatency}
        aria-hidden="true"
      ></span>
    </div>
  </section>
</div>
