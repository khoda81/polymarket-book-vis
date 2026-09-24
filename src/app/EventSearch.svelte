<script lang="ts">
  import { onMount } from "svelte";
  import { buildChartDefinition } from "../lib/chartDefinition";
  import { loadEventDetails, type EventDetails } from "../lib/eventDetails";
  import {
    initialMarketLifecycle,
    summarizeEventMarketStatus,
  } from "../lib/marketLifecycle";
  import { fmtVol, relativeTimeDisplay } from "../lib/math";
  import { errorMessage } from "./model";
  import {
    createPublicClient,
    type Event,
    type EventId,
    type Series,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let client: PublicClient;
  export let status: string;
  export let loadedEventIds: ReadonlySet<EventId> = new Set();
  export let onchoose: (event: Event) => void;
  export let onchooseseries: (series: Series) => void = () => undefined;
  export let onstatus: (message: string) => void;

  type SearchLifecycle =
    "open" | "resolved" | "awaiting-resolution" | "closed" | "inactive";

  interface SearchMatch {
    readonly event: Event;
    readonly details: EventDetails | null | undefined;
  }

  interface ResolutionSummary {
    readonly text: string;
    readonly color: string | null;
  }

  interface ResolvedRow {
    readonly title: string;
    readonly label: string;
    readonly primary: boolean;
    readonly color: string | null;
  }

  const SEARCH_PAGE_SIZE = 32;

  let root: HTMLDivElement;
  let query = "";
  let matches: SearchMatch[] = [];
  let sortedMatches: SearchMatch[] = [];
  let highlighted = 0;
  let open = false;
  let generation = 0;
  let timer: number | undefined;
  let searching = false;
  const detailsCache = new Map<EventId, EventDetails | null>();

  $: sortedMatches = sortMatches(matches, loadedEventIds);

  function eventLifecycle(event: Event): SearchLifecycle {
    const summary = summarizeEventMarketStatus(
      event.markets.map(initialMarketLifecycle),
    );
    if (summary.kind === "resolved") return "resolved";
    if (summary.kind === "awaiting-resolution") return "awaiting-resolution";
    if (
      event.state.closed === false &&
      event.markets.some((market) => market.state.acceptingOrders === true)
    )
      return "open";
    return event.state.closed === true ? "closed" : "inactive";
  }

  function resultPriority(
    event: Event,
    loadedIds: ReadonlySet<EventId>,
  ): number {
    if (!loadedIds.has(event.id) && eventLifecycle(event) === "open") return 0;
    if (loadedIds.has(event.id)) return 1;
    if (eventLifecycle(event) === "resolved") return 2;
    return 3;
  }

  function sortMatches(
    values: readonly SearchMatch[],
    loadedIds: ReadonlySet<EventId>,
  ): SearchMatch[] {
    return values
      .map((match, index) => ({ match, index }))
      .sort(
        (a, b) =>
          resultPriority(a.match.event, loadedIds) -
            resultPriority(b.match.event, loadedIds) || a.index - b.index,
      )
      .map(({ match }) => match);
  }

  function statusText(event: Event): string {
    switch (eventLifecycle(event)) {
      case "awaiting-resolution":
        return "pending";
      case "closed":
        return "closed";
      case "inactive":
        return "inactive";
      default:
        return "";
    }
  }

  function iconUrl(event: Event): string | null {
    return event.icon?.trim() || event.image?.trim() || null;
  }

  function description(event: Event): string {
    return (
      event.description?.trim().replace(/\s+/g, " ") ??
      event.subtitle?.trim() ??
      ""
    );
  }

  function timestampMs(value: unknown): number | null {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function nextResolutionMs(event: Event): number | null {
    const liveTimes = event.markets.flatMap((market) => {
      if (initialMarketLifecycle(market).kind !== "live") return [];
      const value = timestampMs(market.state.endDate);
      return value === null ? [] : [value];
    });
    return liveTimes.length > 0 ? Math.min(...liveTimes) : null;
  }

  function timeUntilResolution(event: Event): string {
    const resolutionMs = nextResolutionMs(event);
    if (resolutionMs === null) return "";

    const display = relativeTimeDisplay(
      Math.max(0, resolutionMs - Date.now()) / 1000,
      "remaining",
    );
    return display.text === "due" ? "due" : `T−${display.text}`;
  }

  function resolvedRowsFromEvent(event: Event): ResolvedRow[] {
    return event.markets.flatMap((market) => {
      const lifecycle = initialMarketLifecycle(market);
      if (lifecycle.kind !== "resolved") return [];

      const primary = lifecycle.winningTokenId === market.outcomes.yes.tokenId;
      const label = primary
        ? market.outcomes.yes.label || lifecycle.winningOutcome
        : market.outcomes.no.label || lifecycle.winningOutcome;

      return [
        {
          title: market.groupItemTitle ?? market.question ?? label,
          label,
          primary,
          color: null,
        },
      ];
    });
  }

  function resolvedRowsFromDetails(details: EventDetails): ResolvedRow[] {
    const definition = buildChartDefinition(details);
    return definition.controls.flatMap((control) => {
      const lifecycle = control.lifecycle;
      if (lifecycle.kind !== "resolved") return [];

      const primary = lifecycle.winningTokenId === control.tokenId;
      const opposite =
        control.market.outcomes.no.tokenId !== null &&
        lifecycle.winningTokenId === control.market.outcomes.no.tokenId;
      const label = primary
        ? control.market.outcomes.yes.label || lifecycle.winningOutcome
        : opposite
          ? control.market.outcomes.no.label || lifecycle.winningOutcome
          : lifecycle.winningOutcome;

      return [
        {
          title: control.title,
          label,
          primary,
          color: primary
            ? control.primaryColor
            : opposite
              ? control.oppositeColor
              : null,
        },
      ];
    });
  }

  function summarizeResolution(
    rows: readonly ResolvedRow[],
  ): ResolutionSummary {
    if (rows.length === 0) return { text: "Resolved", color: null };
    if (rows.length === 1)
      return { text: rows[0]!.label, color: rows[0]!.color };

    const primaryWinners = rows.filter((row) => row.primary);
    if (primaryWinners.length === 1)
      return {
        text: primaryWinners[0]!.title,
        color: primaryWinners[0]!.color,
      };

    const labels = [...new Set(rows.map((row) => row.label))];
    if (labels.length === 1) return { text: labels[0]!, color: rows[0]!.color };

    return { text: "Resolved", color: null };
  }

  function resolutionSummary(match: SearchMatch): ResolutionSummary | null {
    if (eventLifecycle(match.event) !== "resolved") return null;
    return summarizeResolution(
      match.details
        ? resolvedRowsFromDetails(match.details)
        : resolvedRowsFromEvent(match.event),
    );
  }

  async function detailsFor(event: Event): Promise<EventDetails | null> {
    if (detailsCache.has(event.id)) return detailsCache.get(event.id) ?? null;
    try {
      const details = await loadEventDetails(client, event);
      detailsCache.set(event.id, details);
      return details;
    } catch {
      detailsCache.set(event.id, null);
      return null;
    }
  }

  async function enrichResolvedMatch(
    event: Event,
    searchGeneration: number,
  ): Promise<void> {
    const details = await detailsFor(event);
    if (searchGeneration !== generation) return;
    matches = matches.map((match) =>
      match.event.id === event.id ? { event, details } : match,
    );
  }

  function eventVolume(event: Event): number {
    const raw = event.metrics.volume;
    const value = raw ? Number.parseFloat(raw) : 0;
    return Number.isFinite(value) ? value : 0;
  }

  function looksLikeExactSlug(value: string): boolean {
    return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value);
  }

  async function findSeriesBySlug(slug: string): Promise<Series | null> {
    const page = await client
      .listSeries({ slug: [slug], pageSize: 10 })
      .firstPage();
    return page.items.find((series) => series.slug?.trim() === slug) ?? null;
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
      const search = client.search({ q: value, pageSize: SEARCH_PAGE_SIZE });
      const page = await search.firstPage();
      if (searchGeneration !== generation) return;

      const events = page.items.events;
      matches = events.map((event) => ({
        event,
        details: detailsCache.get(event.id),
      }));
      highlighted = 0;
      open = matches.length > 0;
      searching = false;

      for (const event of events)
        if (eventLifecycle(event) === "resolved")
          void enrichResolvedMatch(event, searchGeneration);
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
      const [seriesResult, eventResult] = await Promise.allSettled([
        findSeriesBySlug(value),
        client.fetchEvent({ slug: value }),
      ]);

      if (
        seriesResult.status === "fulfilled" &&
        seriesResult.value?.recurrence?.trim()
      ) {
        acceptSeries(seriesResult.value);
        return;
      }

      if (eventResult.status === "fulfilled") {
        accept(eventResult.value);
        return;
      }

      const selected = sortedMatches[highlighted];
      if (selected) {
        accept(selected.event);
        return;
      }

      const reason =
        eventResult.status === "rejected"
          ? eventResult.reason
          : seriesResult.status === "rejected"
            ? seriesResult.reason
            : "No matching event or recurring series";
      onstatus(`Could not resolve slug: ${errorMessage(reason)}`);
      return;
    }

    const selected = sortedMatches[highlighted];
    if (selected) accept(selected.event);
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
      highlighted =
        (highlighted - 1 + sortedMatches.length) % sortedMatches.length;
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
        {@const lifecycle = eventLifecycle(match.event)}
        {@const resolution = resolutionSummary(match)}
        <button
          type="button"
          class="dashboard-search-result"
          class:dashboard-search-result--inactive={lifecycle !== "open"}
          class:dashboard-search-result--loaded={loadedEventIds.has(
            match.event.id,
          )}
          role="option"
          aria-selected={index === highlighted}
          onpointerenter={() => (highlighted = index)}
          onclick={() => accept(match.event)}
        >
          <span class="dashboard-search-result-artwork" aria-hidden="true">
            {#if iconUrl(match.event)}
              <img
                src={iconUrl(match.event) ?? ""}
                alt=""
                onerror={(event) => (event.currentTarget.hidden = true)}
              />
            {/if}
          </span>

          <span class="dashboard-search-result-copy">
            <span class="dashboard-search-result-title-line">
              <span class="dashboard-search-result-title">
                {match.event.title ?? "(untitled)"}
              </span>
              {#if loadedEventIds.has(match.event.id)}
                <span
                  class="dashboard-search-result-loaded-mark"
                  aria-label="Already in dashboard"
                  title="Already in dashboard">✓</span
                >
              {/if}
            </span>

            {#if description(match.event)}
              <span
                class="dashboard-search-result-subtitle"
                title={description(match.event)}
              >
                {description(match.event)}
              </span>
            {/if}
          </span>

          <span class="dashboard-search-result-side">
            {#if resolution}
              <span
                class="dashboard-search-result-resolution"
                title={`Resolved to ${resolution.text}`}
                style={resolution.color
                  ? `color: ${resolution.color}`
                  : undefined}
              >
                <span
                  class="dashboard-search-result-resolution-dot"
                  aria-hidden="true"
                ></span>
                <span>{resolution.text}</span>
              </span>
            {:else if lifecycle === "open" && timeUntilResolution(match.event)}
              <span
                class="dashboard-search-result-time"
                title="Time until next live market resolution"
              >
                {timeUntilResolution(match.event)}
              </span>
            {:else if statusText(match.event)}
              <span class="dashboard-search-result-state">
                {statusText(match.event)}
              </span>
            {/if}
            <span class="dashboard-search-result-volume">
              ${fmtVol(eventVolume(match.event))}
            </span>
          </span>
        </button>
      {/each}
    </div>
  </div>
</form>
