<script lang="ts">
  import { onMount } from "svelte";
  import { loadEventBundle, type EventPresentation } from "../lib/eventBundle";
  import { initialMarketLifecycle, summarizeEventMarketStatus } from "../lib/marketLifecycle";
  import { fmtVol } from "../lib/math";
  import { findSeriesBySlug } from "../lib/seriesTimeline";
  import { errorMessage, type EventSlug, toEventSlug } from "./model";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let client: PublicClient;
  export let status: string;
  export let loadedEventIds: ReadonlySet<string> = new Set();
  export let onchoose: (event: Event) => void;
  export let onchooseseries: (series: Series) => void = () => undefined;
  export let onstatus: (message: string) => void;

  type SearchLifecycle =
    | "open"
    | "resolved"
    | "awaiting-resolution"
    | "closed"
    | "inactive";

  interface SearchMatch {
    readonly event: Event;
    readonly presentation: EventPresentation | null;
  }

  let root: HTMLDivElement;
  let query = "";
  let matches: SearchMatch[] = [];
  let sortedMatches: SearchMatch[] = [];
  let highlighted = 0;
  let open = false;
  let generation = 0;
  let timer: number | undefined;
  let searching = false;
  const presentationCache = new Map<string, EventPresentation | null>();
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  $: sortedMatches = sortMatches(matches);

  function isInDashboard(event: Event): boolean {
    return loadedEventIds.has(String(event.id));
  }

  function lifecycle(event: Event): SearchLifecycle {
    const lifecycles = event.markets.map(initialMarketLifecycle);
    const summary = summarizeEventMarketStatus(lifecycles);
    if (summary.kind === "resolved") return "resolved";
    if (summary.kind === "awaiting-resolution") return "awaiting-resolution";
    if (
      event.state.closed === false &&
      event.markets.some((market) => market.state.acceptingOrders === true)
    )
      return "open";
    return event.state.closed === true ? "closed" : "inactive";
  }

  function resultPriority(event: Event): number {
    if (!isInDashboard(event) && lifecycle(event) === "open") return 0;
    if (isInDashboard(event)) return 1;
    if (lifecycle(event) === "resolved") return 2;
    return 3;
  }

  function sortMatches(values: readonly SearchMatch[]): SearchMatch[] {
    return values
      .map((match, index) => ({ match, index }))
      .sort(
        (a, b) =>
          resultPriority(a.match.event) - resultPriority(b.match.event) ||
          a.index - b.index,
      )
      .map(({ match }) => match);
  }

  function lifecycleLabel(event: Event): string {
    switch (lifecycle(event)) {
      case "open":
        return "Open";
      case "resolved":
        return "Resolved";
      case "awaiting-resolution":
        return "Awaiting resolution";
      case "closed":
        return "Closed";
      default:
        return "Inactive";
    }
  }

  function lifecycleClass(event: Event): string {
    return `dashboard-search-result-state--${lifecycle(event)}`;
  }

  function resolutionDateText(match: SearchMatch): string {
    const raw = match.presentation?.endDate;
    if (!raw) return "";
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return "";
    const date = dateFormatter.format(new Date(timestamp));
    return lifecycle(match.event) === "open"
      ? `Resolves ${date}`
      : `Resolution date ${date}`;
  }

  function resolutionSourceLabel(source: string | null | undefined): string {
    if (!source) return "";
    try {
      return new URL(source).hostname.replace(/^www\./, "");
    } catch {
      return source;
    }
  }

  async function presentationFor(event: Event): Promise<EventPresentation | null> {
    const id = String(event.id);
    if (presentationCache.has(id)) return presentationCache.get(id) ?? null;
    try {
      const presentation = (await loadEventBundle(client, event)).presentation;
      presentationCache.set(id, presentation);
      return presentation;
    } catch {
      presentationCache.set(id, null);
      return null;
    }
  }

  function eventVolume(event: Event): number {
    const raw = event.metrics.volume;
    const value = raw ? Number.parseFloat(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  }

  function looksLikeExactSlug(value: string): value is EventSlug {
    return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value);
  }

  function clearResults(): void {
    matches = [];
    highlighted = 0;
    open = false;
  }

  function accept(event: Event): void {
    generation++;
    if (timer !== undefined) window.clearTimeout(timer);
    searching = false;
    query = "";
    clearResults();
    onchoose(event);
  }

  function acceptSeries(series: Series): void {
    generation++;
    if (timer !== undefined) window.clearTimeout(timer);
    searching = false;
    query = "";
    clearResults();
    onchooseseries(series);
  }

  async function searchNow(
    value: string,
    searchGeneration: number,
  ): Promise<void> {
    try {
      const search = client.search({ q: value, pageSize: 12 });
      const page = await search.firstPage();
      if (searchGeneration !== generation) return;

      const events = page.items.events;
      matches = events.map((event) => ({
        event,
        presentation: presentationCache.get(String(event.id)) ?? null,
      }));
      highlighted = 0;
      open = matches.length > 0;

      const enriched = await Promise.all(
        events.map(async (event) => ({
          event,
          presentation: await presentationFor(event),
        })),
      );
      if (searchGeneration !== generation) return;
      matches = enriched;
      searching = false;
    } catch (error) {
      if (searchGeneration !== generation) return;
      searching = false;
      clearResults();
      onstatus(`Search failed: ${errorMessage(error)}`);
    }
  }

  function scheduleSearch(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    const value = query.trim();
    const searchGeneration = ++generation;

    if (!value) {
      searching = false;
      clearResults();
      return;
    }

    searching = true;
    timer = window.setTimeout(() => {
      void searchNow(value, searchGeneration);
    }, 200);
  }

  async function submit(): Promise<void> {
    const value = query.trim();
    if (!value) return;

    const exact = sortedMatches.find((match) => match.event.slug === value);
    if (exact) {
      accept(exact.event);
      return;
    }

    if (looksLikeExactSlug(value)) {
      try {
        const series = await findSeriesBySlug(client, value);
        if (series?.recurrence?.trim()) {
          acceptSeries(series);
          return;
        }
      } catch {
        // Series lookup is opportunistic; continue with event resolution.
      }

      try {
        const event = await client.fetchEvent({ slug: value });
        accept(event);
        return;
      } catch {
        // Slug-shaped text can still be a useful free-text query.
      }
    }

    const selected = sortedMatches[highlighted];
    if (selected) {
      accept(selected.event);
      return;
    }

    const slug = toEventSlug(value);
    if (!slug) return;
    try {
      const event = await client.fetchEvent({ slug });
      accept(event);
    } catch (error) {
      onstatus(`Could not add event: ${errorMessage(error)}`);
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (!sortedMatches.length) {
      if (event.key === "Escape") open = false;
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted = (highlighted + 1) % sortedMatches.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = (highlighted - 1 + matches.length) % sortedMatches.length;
    } else if (event.key === "Escape") {
      event.preventDefault();
      open = false;
    }
  }

  onMount(() => {
    const pointerDown = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) open = false;
    };
    document.addEventListener("pointerdown", pointerDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  });
</script>

<form
  class="dashboard-add-form"
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <div class="dashboard-add-heading">
    <label for="event-search">Add event</label>
    <span class="dashboard-add-status" aria-live="polite" title={status}>
      {status}
    </span>
  </div>
  <div class="dashboard-search" bind:this={root}>
    <input
      id="event-search"
      name="query"
      type="text"
      role="combobox"
      placeholder="Search events or paste an event/series slug…"
      autocomplete="off"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-controls="event-search-results"
      aria-expanded={open}
      aria-busy={searching}
      bind:value={query}
      oninput={scheduleSearch}
      onfocus={() => {
        if (matches.length) open = true;
      }}
      onkeydown={keydown}
    />
    {#if searching}
      <span
        class="dashboard-search-spinner"
        aria-hidden="true"
        title="Searching"
      ></span>
    {/if}

    <div
      class="dashboard-search-results"
      class:dashboard-search-results--open={open}
      id="event-search-results"
      role="listbox"
    >
      {#each sortedMatches as match, index (match.event.id)}
        <button
          type="button"
          class="dashboard-search-result"
          role="option"
          aria-selected={index === highlighted}
          onpointerenter={() => (highlighted = index)}
          onclick={() => accept(match.event)}
        >
          <span class="dashboard-search-result-artwork" aria-hidden="true">
            {#if match.presentation?.iconUrl}
              <img
                src={match.presentation.iconUrl}
                alt=""
                onerror={(event) => (event.currentTarget.hidden = true)}
              />
            {/if}
          </span>
          <span class="dashboard-search-result-copy">
            <span class="dashboard-search-result-heading">
              <span class="dashboard-search-result-title">
                {match.event.title ?? "(untitled)"}
              </span>
              <span class="dashboard-search-result-badges">
                {#if isInDashboard(match.event)}
                  <span
                    class="dashboard-search-result-badge dashboard-search-result-badge--loaded"
                    >In dashboard</span
                  >
                {/if}
                <span
                  class={`dashboard-search-result-badge dashboard-search-result-state ${lifecycleClass(match.event)}`}
                  >{lifecycleLabel(match.event)}</span
                >
              </span>
            </span>

            {#if match.presentation?.subtitle ?? match.presentation?.description?.preview}
              <span class="dashboard-search-result-subtitle">
                {match.presentation?.subtitle ??
                  match.presentation?.description?.preview}
              </span>
            {/if}

            <span class="dashboard-search-result-meta">
              <span class="dashboard-search-result-slug">
                {match.event.slug ?? match.event.id}
              </span>
              <span class="dashboard-search-result-volume">
                ${fmtVol(eventVolume(match.event))}
              </span>
            </span>

            {#if resolutionDateText(match) || match.presentation?.resolutionSource}
              <span class="dashboard-search-result-resolution">
                {#if resolutionDateText(match)}
                  <span>{resolutionDateText(match)}</span>
                {/if}
                {#if match.presentation?.resolutionSource}
                  <span
                    class="dashboard-search-result-source"
                    title={match.presentation.resolutionSource}
                    >via {resolutionSourceLabel(
                      match.presentation.resolutionSource,
                    )}</span
                  >
                {/if}
              </span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  </div>
</form>
