<script lang="ts">
  import { onMount } from "svelte";
  import type { Market } from "@polymarket/client";
  import type { WallClockWatch } from "../../shared/wallClock";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import {
    marketTimeDisplay,
    marketTimeMarker,
    marketTimeTooltip,
  } from "../../domain/markets/marketDeadline";

  export let market: Market;

  const { wallClock } = getVisualizationContext();
  let element: HTMLSpanElement;
  let watch: WallClockWatch | undefined;
  $: marker = marketTimeMarker(market);
  $: (marker, watch?.refresh());
  $: title = marketTimeTooltip(marker);

  onMount(() => {
    watch = wallClock.watch((nowMs) => {
      const display = marketTimeDisplay(marker, nowMs);
      const node = element.firstChild as Text;
      if (node.data !== display.text) node.data = display.text;
      return display.nextChangeMs === null
        ? null
        : nowMs + Math.ceil(display.nextChangeMs) + 1;
    });
    return () => watch?.destroy();
  });
</script>

<span
  class="cpv-market-deadline"
  data-masonry-layout-neutral
  data-market-time-kind={marker?.kind}
  data-market-time-ms={marker?.timeMs}
  {title}
  bind:this={element}>{marketTimeDisplay(marker, wallClock.nowMs).text}</span
>
