<script lang="ts">
  import { onMount } from "svelte";
  import { AGE_ROW_BAND_PX } from "../../chart/age/ageStripTuning";
  import { GhostMemoryScale } from "../../chart/age/ghostMemoryScale";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import { shareLegendTicks } from "../../rendering/legends/shareLegendTicks";
  import {
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    signedVolumeColor,
  } from "../../rendering/colors/signedVolume";

  const visualization = getVisualizationContext();

  const SHARE_TICK_MIN_SPACING_PX = 24;
  const SHARE_TICK_FULL_OPACITY_SPACING_PX = 32;
  let shareBar: HTMLDivElement;
  let ghostCanvas: HTMLCanvasElement;
  let shareWidth = $state(0);
  let shareDpr = $state(1);
  let ghost: GhostMemoryScale | null = null;

  const tuning = $derived(visualization.tuning.get());
  const observationFrame = $derived(visualization.observations.read());
  const shareTicks = $derived(
    shareLegendTicks(tuning.volumePerCssPixel * AGE_ROW_BAND_PX, shareWidth, {
      minSpacingPx: SHARE_TICK_MIN_SPACING_PX,
      fullOpacitySpacingPx: SHARE_TICK_FULL_OPACITY_SPACING_PX,
      dpr: shareDpr,
    }),
  );
  const negativeColor = $derived(
    signedVolumeColor(-1, DEFAULT_SIGNED_VOLUME_COLOR_SCALE),
  );
  const positiveColor = $derived(
    signedVolumeColor(1, DEFAULT_SIGNED_VOLUME_COLOR_SCALE),
  );

  $effect(() => {
    // Always read the reactive inputs, even before the imperative canvas
    // resource exists. Optional-chaining the whole call here can otherwise
    // short-circuit dependency discovery while ghost is still null.
    const frame = observationFrame;
    const halfLifeMs = tuning.ghostHalfLifeMs;
    ghost?.setInputs(frame, halfLifeMs);
  });

  onMount(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      shareWidth = entry.contentRect.width;
      shareDpr = window.devicePixelRatio || 1;
    });
    observer.observe(shareBar);
    shareWidth = shareBar.clientWidth;
    shareDpr = window.devicePixelRatio || 1;

    const nextGhost = new GhostMemoryScale(ghostCanvas, visualization.tuning);
    ghost = nextGhost;
    // ghost itself is intentionally not reactive state. Seed the imperative
    // resource explicitly, then the effect above keeps it synchronized.
    nextGhost.setInputs(observationFrame, tuning.ghostHalfLifeMs);

    return () => {
      ghost = null;
      nextGhost.destroy();
      observer.disconnect();
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
    <canvas
      class="ghost-memory-canvas"
      bind:this={ghostCanvas}
      aria-label="Ghost memory: awaiting observation"
    ></canvas>
  </section>
</div>
