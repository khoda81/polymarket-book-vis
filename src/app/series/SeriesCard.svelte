<script lang="ts">
  import CardActions from "../dashboard/CardActions.svelte";
  import SeriesHeader from "./SeriesHeader.svelte";
  import SeriesMarkets from "./SeriesMarkets.svelte";
  import {
    cardReorderSurface,
    type CardReorderStart,
  } from "../dashboard/cardReorderSurface";
  import type { ViewMode } from "../../domain/markets/chartState";
  import type { Series } from "@polymarket/client";

  export let series: Series;
  export let pinned: boolean;
  export let onpin: (pinned: boolean) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;
  export let onreorderstart: (start: CardReorderStart) => void;
  export let onreorderstep: (direction: -1 | 1) => void;

  let viewMode: ViewMode = "age";
  let ready = false;

  function marketsReady(): void {
    if (ready) return;
    ready = true;
    onready();
  }
</script>

<article
  class="card series-card"
  class:card--pinned={pinned}
  data-series-id={series.id}
  use:cardReorderSurface={onreorderstart}
>
  <CardActions
    kind="series"
    title={series.title}
    {pinned}
    {ready}
    bind:viewMode
    {onpin}
    {onremove}
    {onreorderstep}
  />

  <div class="cpv-wrap">
    <SeriesHeader {series} />

    {#if series.description?.trim()}
      <p class="cpv-event-description series-description">
        {series.description}
      </p>
    {/if}

    <SeriesMarkets {series} {viewMode} onready={marketsReady} {onfailure} />
  </div>
</article>
