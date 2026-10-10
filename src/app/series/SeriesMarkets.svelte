<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import AgeRowFlipButton from "../charts/AgeRowFlipButton.svelte";
  import MarketDeadline from "../charts/MarketDeadline.svelte";
  import {
    SeriesMarketListView,
    SERIES_LABEL_GUTTER_PX,
    type SeriesMarketListRenderInput,
    type SeriesPagingState,
    type SeriesVisibleMarket,
  } from "../../chart/series/seriesMarketListView";
  import {
    DEFAULT_AGE_ROW_ORIENTATION,
    type AgeRowOrientation,
  } from "../../chart/age/ageStripOrientation";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import type { ObservationPoint } from "../../domain/pressure/observationClock";
  import type { ConnectionStatus } from "../../domain/markets/chartState";
  import type { Event, Market, Series } from "@polymarket/client";

  interface Props {
    series: Series;
    ageRowOrientation?: AgeRowOrientation;
    onready?: () => void;
    onfailure?: (message: string) => void;
    onconnection?: (status: ConnectionStatus) => void;
    onanchorevent?: (event: Event | null) => void;
    onrowflip?: () => void;
  }

  let {
    series,
    ageRowOrientation = DEFAULT_AGE_ROW_ORIENTATION,
    onready = () => undefined,
    onfailure = () => undefined,
    onconnection = () => undefined,
    onanchorevent = () => undefined,
    onrowflip = () => undefined,
  }: Props = $props();

  const visualization = getVisualizationContext();
  const observationPointsByToken = new SvelteMap<string, ObservationPoint>();
  let canvas: HTMLCanvasElement;
  let pressureCanvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let scrollContainer: HTMLDivElement;
  let scrollContent: HTMLDivElement;
  let view = $state<SeriesMarketListView | null>(null);
  let following = $state(true);
  let visibleMarkets = $state<readonly SeriesVisibleMarket[]>([]);
  let paging = $state<SeriesPagingState>({
    loading: true,
  });
  let message = $state("");

  function marketName(market: Market): string {
    return market.groupItemTitle ?? market.question ?? "(untitled)";
  }

  function renderInput(): SeriesMarketListRenderInput {
    const tuning = visualization.tuning.get();
    return {
      ageRowOrientation,
      observationReference: visualization.observations.readReference(),
      volumePerCssPixel: tuning.volumePerCssPixel,
      ghostHalfLifeMs: tuning.ghostHalfLifeMs,
    };
  }

  $effect(() => view?.updateRenderInputs(renderInput()));

  onMount(() => {
    const list = new SeriesMarketListView(
      canvas,
      pressureCanvas,
      canvasWrap,
      scrollContainer,
      scrollContent,
      visualization.client,
      observationPointsByToken,
      visualization.observations,
      visualization.tuning,
      visualization.presentation,
      series,
      renderInput(),
      {
        onConnectionStatus: onconnection,
        onFollowingChanged: (value) => (following = value),
        onEventsChanged: () => (message = ""),
        onVisibleMarketsChanged: (markets) => (visibleMarkets = markets),
        onPagingChanged: (state) => (paging = state),
        onAnchorEventChanged: onanchorevent,
        onError: (error) => (message = error),
      },
    );
    view = list;
    void list.start().then(onready, (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      message = text;
      onfailure(text);
    });
    return () => {
      view = null;
      list.destroy();
    };
  });
</script>

<div class="cpv-chart-stage">
  <div class="cpv-chart-row-flip">
    <AgeRowFlipButton orientation={ageRowOrientation} onflip={onrowflip} />
  </div>
  <div class="series-scroll-tools" data-masonry-layout-neutral>
    {#if !following}
      <button type="button" onclick={() => view?.followLive()}
        >Jump to current</button
      >
    {/if}
    {#if message || paging.loading}
      <span class="series-scroll-status" role="status">
        {message || "Loading markets…"}
      </span>
      {#if message && !paging.loading}
        <button type="button" onclick={() => view?.retryLoading()}>Retry</button
        >
      {/if}
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region must be keyboard reachable.) -->
  <div
    class="series-market-scroll"
    role="region"
    aria-label={`${series.title ?? "Series"} markets`}
    tabindex="0"
    bind:this={scrollContainer}
  >
    <div class="series-scroll-content" bind:this={scrollContent}>
      <div class="cpv-canvas-wrap series-canvas-wrap" bind:this={canvasWrap}>
        <canvas
          class="cpv-pressure-canvas"
          aria-hidden="true"
          bind:this={pressureCanvas}
        ></canvas>
        <canvas
          class="cpv-main-canvas"
          bind:this={canvas}
          aria-label="Series market order books"
        ></canvas>
        <div
          class="series-market-labels"
          data-masonry-layout-neutral
          style:width={`${SERIES_LABEL_GUTTER_PX}px`}
        >
          {#each visibleMarkets as item (item.row.tokenId)}
            {@const market = item.row.market}
            {@const event = item.row.event}
            <a
              class="series-market-label"
              style:top={`${item.centerY}px`}
              href={`https://polymarket.com/event/${event.slug ?? event.id}`}
              target="_blank"
              rel="noreferrer"
              data-market-id={market.id}
              data-event-id={event.id}
              data-token-id={item.row.tokenId}
              title={`${market.question ?? marketName(market)}\n${event.title ?? "Event"} · ${event.slug ?? event.id}`}
            >
              <span class="cpv-market-label-text">{marketName(market)}</span>
              <MarketDeadline deadlineMs={item.row.deadlineMs} />
              {#if market.state.archived}
                <span class="series-market-status">archived</span>
              {:else if item.lifecycle.kind === "resolved"}
                <span class="series-market-status"
                  >Resolved · {item.lifecycle.winningOutcome}</span
                >
              {:else if item.lifecycle.kind === "awaiting-resolution"}
                <span class="series-market-status">pending</span>
              {/if}
            </a>
          {/each}
        </div>
      </div>
    </div>
  </div>
</div>
