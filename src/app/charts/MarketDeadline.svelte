<script lang="ts">
  import { onMount } from "svelte";
  import type { Market } from "@polymarket/client";
  import {
    marketTimeDisplay,
    marketTimeMarker,
    marketTimeTooltip,
  } from "../../domain/markets/marketDeadline";

  export let market: Market;

  let element: HTMLSpanElement;
  let refresh: () => void = () => undefined;
  $: marker = marketTimeMarker(market);
  $: (marker, refresh());
  $: title = marketTimeTooltip(marker);

  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    refresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      const display = marketTimeDisplay(marker, Date.now());
      const node = element.firstChild as Text;
      if (node.data !== display.text) node.data = display.text;
      if (display.nextChangeMs !== null)
        timer = setTimeout(
          refresh,
          Math.min(2_147_483_647, Math.ceil(display.nextChangeMs) + 1),
        );
    };
    refresh();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });
</script>

<span
  class="cpv-market-deadline"
  data-masonry-layout-neutral
  data-market-time-kind={marker?.kind}
  data-market-time-ms={marker?.timeMs}
  {title}
  bind:this={element}>{marketTimeDisplay(marker, Date.now()).text}</span
>
