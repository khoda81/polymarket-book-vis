<script lang="ts">
  import { onMount } from "svelte";
  import { fmtVol } from "../lib/math";
  import { findSeriesBySlug } from "../lib/seriesTimeline";
  import {
    errorMessage,
    type EventSlug,
    toEventSlug,
  } from "./model";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let client: PublicClient;
  export let status: string;
  export let onchoose: (event: Event) => void;
  export let onchooseseries: (series: Series) => void =
    () => undefined;
  export let onstatus: (message: string) => void;

  let root: HTMLDivElement;
  let query = "";
  let matches: Event[] = [];
  let highlighted = 0;
  let open = false;
  let generation = 0;
  let timer: number | undefined;

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
    query = "";
    clearResults();
    onchoose(event);
  }

  function acceptSeries(series: Series): void {
    generation++;
    if (timer !== undefined) window.clearTimeout(timer);
    query = "";
    clearResults();
    onchooseseries(series);
  }

  async function searchNow(value: string, searchGeneration: number): Promise<void> {
    try {
      const search = client.search({ q: value, pageSize: 12 });
      const page = await search.firstPage();
      if (searchGeneration !== generation) return;
      matches = page.items.events;
      highlighted = 0;
      open = matches.length > 0;
    } catch (error) {
      if (searchGeneration !== generation) return;
      clearResults();
      onstatus(`Search failed: ${errorMessage(error)}`);
    }
  }

  function scheduleSearch(): void {
    if (timer !== undefined) window.clearTimeout(timer);
    const value = query.trim();
    const searchGeneration = ++generation;

    if (!value) {
      clearResults();
      return;
    }

    timer = window.setTimeout(() => {
      void searchNow(value, searchGeneration);
    }, 200);
  }

  async function submit(): Promise<void> {
    const value = query.trim();
    if (!value) return;

    const exact = matches.find((event) => event.slug === value);
    if (exact) {
      accept(exact);
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

    const selected = matches[highlighted];
    if (selected) {
      accept(selected);
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
    if (!matches.length) {
      if (event.key === "Escape") open = false;
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlighted = (highlighted + 1) % matches.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlighted = (highlighted - 1 + matches.length) % matches.length;
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
      bind:value={query}
      oninput={scheduleSearch}
      onfocus={() => {
        if (matches.length) open = true;
      }}
      onkeydown={keydown}
    />

    <div
      class="dashboard-search-results"
      class:dashboard-search-results--open={open}
      id="event-search-results"
      role="listbox"
    >
      {#each matches as event, index (event.id)}
        <button
          type="button"
          class="dashboard-search-result"
          role="option"
          aria-selected={index === highlighted}
          onpointerenter={() => (highlighted = index)}
          onclick={() => accept(event)}
        >
          <span class="dashboard-search-result-title">
            {event.title ?? "(untitled)"}
          </span>
          <span class="dashboard-search-result-meta">
            <span class="dashboard-search-result-slug">
              {event.slug ?? event.id}
            </span>
            <span class="dashboard-search-result-volume">
              ${fmtVol(eventVolume(event))}
            </span>
          </span>
        </button>
      {/each}
    </div>
  </div>
</form>
