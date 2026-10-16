<script lang="ts">
  import { errorMessage } from "../../shared/errors";
  import { onMount, tick, untrack } from "svelte";
  import type { Series } from "@polymarket/client";
  import type { ViewMode } from "../../domain/markets/chartState";
  import type { EventDetails } from "../../domain/markets/eventDetails";
  import { initialMarketLifecycle } from "../../domain/markets/marketLifecycle";
  import { isActiveOrderMarket } from "../../domain/markets/marketTradability";
  import {
    mergeSeriesEvents,
    seriesCurrentMarket,
    SeriesEventPager,
    type SeriesPageDirection,
  } from "../../domain/series/seriesMarkets";
  import {
    captureScrollAnchor,
    restoreScrollAnchor,
    scrollToMarket,
    type ScrollAnchor,
  } from "./scrollAnchor";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import EventContent from "../events/EventContent.svelte";
  import { loadStoredAgeRowOrientation } from "../charts/ageRowOrientationStorage";

  let {
    series,
    viewMode,
    onready = () => undefined,
    onfailure = () => undefined,
  }: {
    series: Series;
    viewMode: ViewMode;
    onready?: () => void;
    onfailure?: (message: string) => void;
  } = $props();
  const visualization = getVisualizationContext();
  // Migrate the old series-wide manual choice as a fallback for shared groups.
  const orientationFallback = untrack(() =>
    loadStoredAgeRowOrientation({ kind: "series", id: series.id }),
  );
  const pager = new SeriesEventPager(
    visualization.client,
    untrack(() => series),
  );
  let bundles = $state<readonly EventDetails[]>([]);
  let scrollContainer: HTMLDivElement;
  let scrollContent: HTMLDivElement;
  let following = $state(true);
  let loading = $state(0);
  let message = $state("");
  const pending = new Set<SeriesPageDirection | "refresh">();
  const failed = new Set<SeriesPageDirection>();
  let alive = true;
  let previousScrollTop = 0;
  let anchor: ScrollAnchor | null = null;
  let anchorFrame = 0;

  async function merge(details: readonly EventDetails[]): Promise<void> {
    const saved = captureScrollAnchor(scrollContainer);
    const byId = new Map(
      [...bundles, ...details].map((bundle) => [bundle.event.id, bundle]),
    );
    bundles = mergeSeriesEvents(
      [...byId.values()].map((bundle) => bundle.event),
    ).map((event) => byId.get(event.id)!);
    await tick();
    if (!alive) return;
    restoreScrollAnchor(scrollContainer, saved);
    previousScrollTop = scrollContainer.scrollTop;
    anchor = captureScrollAnchor(scrollContainer);
  }
  function atEdge(direction: SeriesPageDirection): boolean {
    return direction === "older"
      ? scrollContainer.scrollTop < 64
      : scrollContainer.scrollHeight -
          scrollContainer.clientHeight -
          scrollContainer.scrollTop <
          64;
  }
  async function load(direction: SeriesPageDirection): Promise<void> {
    if (
      !alive ||
      pending.has(direction) ||
      pending.has("refresh") ||
      failed.has(direction) ||
      !pager.hasMore(direction)
    )
      return;
    pending.add(direction);
    loading++;
    try {
      // A page can add events below the current anchor (open and closed API
      // collections overlap). Being at an edge must not drain all history.
      do {
        const details = await pager.load(direction);
        if (!alive) return;
        await merge(details);
      } while (
        scrollContainer.scrollHeight <= scrollContainer.clientHeight &&
        pager.hasMore(direction)
      );
      if (failed.size === 0) message = "";
    } catch (error) {
      if (!alive) return;
      failed.add(direction);
      message = errorMessage(error);
    } finally {
      pending.delete(direction);
      loading--;
    }
  }
  function scrolled(): void {
    const current = scrollContainer.scrollTop;
    const direction = current < previousScrollTop ? "older" : "newer";
    previousScrollTop = current;
    anchor = captureScrollAnchor(scrollContainer);
    if (atEdge(direction)) void load(direction);
  }
  function scrollIntent(direction: SeriesPageDirection): void {
    following = false;
    if (atEdge(direction)) void load(direction);
  }
  function wheel(event: WheelEvent): void {
    if (event.ctrlKey || event.deltaY === 0) return;
    scrollIntent(event.deltaY < 0 ? "older" : "newer");
  }
  function keydown(event: KeyboardEvent): void {
    if (event.target !== scrollContainer) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key))
      scrollIntent("older");
    else if (["ArrowDown", "PageDown", "End", " "].includes(event.key))
      scrollIntent("newer");
  }
  async function current(): Promise<void> {
    following = true;
    const marketId = seriesCurrentMarket(
      bundles.map((bundle) => bundle.event),
      Date.now(),
      (market) =>
        isActiveOrderMarket(market) &&
        (
          visualization.markets.lifecycles.get(market.id) ??
          initialMarketLifecycle(market)
        ).kind === "live" &&
        visualization.markets.visibilityFor(
          market.id,
          isActiveOrderMarket(market),
        ).kind === "visible",
    );
    await tick();
    if (!alive) return;
    if (marketId) scrollToMarket(scrollContainer, marketId);
    previousScrollTop = scrollContainer.scrollTop;
    anchor = captureScrollAnchor(scrollContainer);
  }
  async function refresh(): Promise<void> {
    if (pending.size > 0) return;
    pending.add("refresh");
    loading++;
    try {
      const details = await pager.refresh(following ? Date.now() : undefined);
      if (!alive) return;
      await merge(details);
      if (following) await current();
      if (failed.size === 0) message = "";
    } catch (error) {
      if (alive) message = errorMessage(error);
    } finally {
      pending.delete("refresh");
      loading--;
      if (alive && !following) {
        if (atEdge("older")) void load("older");
        if (atEdge("newer")) void load("newer");
      }
    }
  }
  function retry(): void {
    const directions = [...failed];
    failed.clear();
    if (directions.length === 0) void refresh();
    else for (const direction of directions) void load(direction);
  }
  function preserveAnchor(): void {
    cancelAnimationFrame(anchorFrame);
    anchorFrame = requestAnimationFrame(() => {
      restoreScrollAnchor(scrollContainer, anchor);
      previousScrollTop = scrollContainer.scrollTop;
      anchor = captureScrollAnchor(scrollContainer);
    });
  }
  onMount(() => {
    // Initial pages are merged before choosing the current actual market.
    void Promise.all([load("older"), load("newer")]).then(async () => {
      if (!alive) return;
      if (bundles.length === 0 && message) {
        onfailure(message);
        return;
      }
      await current();
      onready();
    });
    const resize = new ResizeObserver(preserveAnchor);
    resize.observe(scrollContent);
    const unsubscribe = visualization.markets.subscribe(preserveAnchor);
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      alive = false;
      cancelAnimationFrame(anchorFrame);
      window.clearInterval(timer);
      resize.disconnect();
      unsubscribe();
    };
  });
</script>

<div class="series-scroll-view">
  <div class="series-scroll-tools" data-masonry-layout-neutral>
    {#if !following}<button
        type="button"
        onclick={() => {
          void current();
          void refresh();
        }}>Jump to current</button
      >{/if}
    {#if message || loading > 0}
      <span class="series-scroll-status" role="status"
        >{message || "Loading events…"}</span
      >
      {#if message && loading === 0}<button type="button" onclick={retry}
          >Retry</button
        >{/if}
    {/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The scroll region supports keyboard pagination and viewport activity.) -->
  <div
    class="series-market-scroll"
    role="region"
    aria-label={`${series.title ?? "Series"} events`}
    tabindex="0"
    bind:this={scrollContainer}
    onscroll={scrolled}
    onwheel={wheel}
    onkeydown={keydown}
    onpointerdown={() => (following = false)}
  >
    <div class="series-scroll-content" bind:this={scrollContent}>
      {#each bundles as bundle (bundle.event.id)}
        <section class="series-event" data-series-event={bundle.event.id}>
          <EventContent
            event={bundle.event}
            {bundle}
            {viewMode}
            {orientationFallback}
            onfailure={(error) => (message = error)}
          />
        </section>
      {/each}
    </div>
  </div>
</div>
