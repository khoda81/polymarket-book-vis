<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    DEFAULT_MIN_VOLUME,
    DEFAULT_RECENCY_DAYS,
    MAX_DISCOVERED_EVENTS,
    MAX_DISCOVERY_AMOUNT,
    MAX_DISCOVERY_RECENCY_DAYS,
    MAX_DISCOVERY_RESULTS,
    discoverEvents,
    parseDiscoveryTopics,
    validateDiscoveryFilters,
    type DiscoveryOrder,
  } from "../../domain/discovery/eventDiscovery";
  import {
    DISCOVERY_DAYS_STORAGE_KEY,
    DISCOVERY_LIQUIDITY_STORAGE_KEY,
    DISCOVERY_TOPICS_STORAGE_KEY,
    DISCOVERY_VOLUME_STORAGE_KEY,
    loadDiscoveryNumber,
  } from "../dashboard/dashboardStorage";
  import type {
    Event,
    EventId,
    PublicClient,
    SeriesId,
  } from "@polymarket/client";

  export let client: PublicClient;
  export let excludedEventIds: ReadonlySet<EventId>;
  export let pinnedSeriesIds: readonly SeriesId[];
  export let onadd: (event: Event) => boolean;

  let status = "";
  let loading = false;
  let run = 0;
  let topics = localStorage.getItem(DISCOVERY_TOPICS_STORAGE_KEY) ?? "";
  let minLiquidity = loadDiscoveryNumber(
    DISCOVERY_LIQUIDITY_STORAGE_KEY,
    0,
    0,
    MAX_DISCOVERY_AMOUNT,
  );
  let order: DiscoveryOrder = "createdAt";
  let minVolume = loadDiscoveryNumber(
    DISCOVERY_VOLUME_STORAGE_KEY,
    DEFAULT_MIN_VOLUME,
    0,
    MAX_DISCOVERY_AMOUNT,
  );
  let recencyDays = loadDiscoveryNumber(
    DISCOVERY_DAYS_STORAGE_KEY,
    DEFAULT_RECENCY_DAYS,
    0,
    MAX_DISCOVERY_RECENCY_DAYS,
  );

  async function refresh(): Promise<void> {
    if (loading) return;
    const request = ++run;
    loading = true;
    status = "Finding matching events…";

    try {
      const filters = {
        topics: parseDiscoveryTopics(topics),
        minVolume,
        minLiquidity,
        recencyDays,
        order,
      };
      validateDiscoveryFilters(filters);
      persistFilters();
      const events = await discoverEvents(
        client,
        filters,
        excludedEventIds,
        Date.now(),
        new Set(pinnedSeriesIds),
      );
      if (request !== run) return;

      const added = events.reduce(
        (count, event) => count + Number(onadd(event)),
        0,
      );
      status = added
        ? `Added ${added} ${added === 1 ? "event" : "events"}. Pin any you want to keep.`
        : `No new matches in the first ${MAX_DISCOVERY_RESULTS} results. Try broader filters or another sort.`;
    } catch (error) {
      if (request === run)
        status = `Discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
    } finally {
      if (request === run) loading = false;
    }
  }

  function persistFilters(): void {
    localStorage.setItem(DISCOVERY_VOLUME_STORAGE_KEY, String(minVolume));
    localStorage.setItem(DISCOVERY_DAYS_STORAGE_KEY, String(recencyDays));
    localStorage.setItem(DISCOVERY_TOPICS_STORAGE_KEY, topics);
    localStorage.setItem(DISCOVERY_LIQUIDITY_STORAGE_KEY, String(minLiquidity));
  }

  onDestroy(() => run++);
</script>

<details class="event-discovery">
  <summary>Discover events</summary>
  <p>
    Not finding what you’re looking for? Browse open, tradable events from any
    topic.
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void refresh();
    }}
  >
    <fieldset disabled={loading}>
      <label class="discovery-topics">
        Topics
        <input
          type="text"
          placeholder="All topics"
          bind:value={topics}
          aria-describedby="discovery-topic-help"
        />
        <span id="discovery-topic-help"
          >Comma-separated topic slugs, e.g. politics, crypto, iran. Matches
          any; leave blank for all.</span
        >
      </label>
      <label
        >Min total volume ($)
        <input
          type="number"
          min="0"
          max={MAX_DISCOVERY_AMOUNT}
          step="1"
          required
          bind:value={minVolume}
        />
      </label>
      <label
        >Min liquidity ($)
        <input
          type="number"
          min="0"
          max={MAX_DISCOVERY_AMOUNT}
          step="1"
          required
          bind:value={minLiquidity}
        />
      </label>
      <label
        >Created within
        <select bind:value={recencyDays}>
          <option value={0}>Any time</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={MAX_DISCOVERY_RECENCY_DAYS}>1 year</option>
        </select>
      </label>
      <label
        >Sort by
        <select bind:value={order}>
          <option value="createdAt">Newest first</option>
          <option value="volume">Highest total volume</option>
          <option value="volume24hr">Highest 24h volume</option>
          <option value="liquidity">Highest liquidity</option>
        </select>
      </label>
      <button type="submit">{loading ? "Loading…" : "Load more events"}</button>
    </fieldset>
    <p class="discovery-help">
      Adds up to {MAX_DISCOVERED_EVENTS} events per click, scanning up to {MAX_DISCOVERY_RESULTS}
      results. Already loaded or dismissed events are skipped.
    </p>
    <p class="discovery-status" role="status">{status}</p>
  </form>
</details>
