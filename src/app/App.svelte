<script lang="ts">
  import { onMount, tick } from "svelte";
  import EventCard from "./events/EventCard.svelte";
  import EventSearch from "./discovery/EventSearch.svelte";
  import DiscoveryPanel from "./discovery/DiscoveryPanel.svelte";
  import PressureLegend from "./shared/PressureLegend.svelte";
  import { provideVisualizationContext } from "./visualization/visualizationContext";
  import SeriesCard from "./series/SeriesCard.svelte";
  import { DashboardReorderController } from "./dashboard/dashboardReorderController";
  import {
    itemKey,
    itemLabel,
    orderDashboardItems,
    eventLabel,
    seriesLabel,
    withPinned,
    type EventDashboardItem,
    type DashboardItem,
    type SeriesDashboardItem,
  } from "./dashboard/model";
  import {
    createPublicClient,
    type Event,
    type EventId,
    type Series,
    type SeriesId,
  } from "@polymarket/client";

  import {
    PINNED_EVENT_IDS_STORAGE_KEY,
    PINNED_SERIES_IDS_STORAGE_KEY,
    LAYOUT_ORDER_STORAGE_KEY,
    DISMISSED_DISCOVERY_STORAGE_KEY,
    MIN_COLUMNS,
    loadDismissedDiscoveryIds,
    loadStoredIds,
    loadLayoutOrder,
    persistIds,
  } from "./dashboard/dashboardStorage";
  import { masonryItem } from "./dashboard/masonryItem";
  import { ColumnLayout } from "./dashboard/columnLayout";

  const client = createPublicClient();
  provideVisualizationContext(client);

  let entries: DashboardItem[] = [];
  let pinnedEventIds = loadStoredIds<EventId>(PINNED_EVENT_IDS_STORAGE_KEY);
  let pinnedSeriesIds = loadStoredIds<SeriesId>(PINNED_SERIES_IDS_STORAGE_KEY);
  let layoutOrder = loadLayoutOrder(pinnedEventIds, pinnedSeriesIds);
  const columnLayout = new ColumnLayout();
  // Display snapshot only; the stylesheet selects the count and owns its curve.
  let columnCount = columnLayout.count;
  let draggingKey: string | null = null;
  let status = "";
  let dismissedDiscoveryIds = loadDismissedDiscoveryIds();
  const reorder = new DashboardReorderController({
    getOrder: () => layoutOrder,
    getColumnCount: () => columnLayout.count,
    setOrder: (order) => (layoutOrder = order),
    setDraggingKey: (key) => (draggingKey = key),
    persistOrder: () => persistLayoutOrder(),
  });

  $: orderedEntries = orderDashboardItems(entries, layoutOrder);
  $: loadedEventIds = new Set(
    entries.flatMap((entry) =>
      entry.kind === "event" ? [entry.event.id] : [],
    ),
  );
  $: discoveryExcludedEventIds = new Set([
    ...dismissedDiscoveryIds,
    ...pinnedEventIds,
    ...loadedEventIds,
  ]);

  function persistDismissedDiscoveryIds(): void {
    localStorage.setItem(
      DISMISSED_DISCOVERY_STORAGE_KEY,
      JSON.stringify([...dismissedDiscoveryIds]),
    );
  }

  function setColumnCount(next: number): void {
    reorder.finish();
    columnLayout.choose(next);
    columnCount = columnLayout.count;
  }

  function commitColumnCount(input: HTMLInputElement): void {
    setColumnCount(Number(input.value));
    input.value = String(columnLayout.count);
  }

  function persistLayoutOrder(): void {
    localStorage.setItem(LAYOUT_ORDER_STORAGE_KEY, JSON.stringify(layoutOrder));
  }

  function rememberLayoutKey(
    key: string,
    placement: "start" | "end" = "end",
  ): void {
    if (layoutOrder.includes(key)) return;
    layoutOrder =
      placement === "start" ? [key, ...layoutOrder] : [...layoutOrder, key];
    persistLayoutOrder();
  }

  function forgetLayoutKey(key: string): void {
    if (!layoutOrder.includes(key)) return;
    layoutOrder = layoutOrder.filter((candidate) => candidate !== key);
    persistLayoutOrder();
  }

  function setEventPinned(
    id: EventId,
    pinned: boolean,
    placement: "start" | "end" = "end",
  ): void {
    pinnedEventIds = withPinned(pinnedEventIds, id, pinned, placement);
    persistIds(PINNED_EVENT_IDS_STORAGE_KEY, pinnedEventIds);
  }

  function setSeriesPinned(
    id: SeriesId,
    pinned: boolean,
    placement: "start" | "end" = "end",
  ): void {
    pinnedSeriesIds = withPinned(pinnedSeriesIds, id, pinned, placement);
    persistIds(PINNED_SERIES_IDS_STORAGE_KEY, pinnedSeriesIds);
  }

  /** Add a card unless it is present; an existing card can be scrolled into view. */
  function addEntry(
    entry: DashboardItem,
    {
      focusExisting = true,
      placement = "end",
    }: { focusExisting?: boolean; placement?: "start" | "end" } = {},
  ): boolean {
    const key = itemKey(entry);
    if (entries.some((candidate) => itemKey(candidate) === key)) {
      if (focusExisting) {
        status = `${itemLabel(entry)} is already on the dashboard.`;
        const selector =
          entry.kind === "series"
            ? `[data-series-id="${CSS.escape(entry.series.id)}"]`
            : `[data-event-id="${CSS.escape(entry.event.id)}"]`;
        void tick().then(() => {
          document
            .querySelector<HTMLElement>(selector)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
      return false;
    }

    rememberLayoutKey(key, placement);
    entries = [...entries, entry];
    return true;
  }

  function removeEntry(entry: DashboardItem): void {
    const key = itemKey(entry);
    forgetLayoutKey(key);
    entries = entries.filter((candidate) => itemKey(candidate) !== key);
  }

  async function addManualEvent(event: Event): Promise<void> {
    status = `Loading ${eventLabel(event)}…`;
    if (dismissedDiscoveryIds.delete(event.id)) persistDismissedDiscoveryIds();

    const recurring = await recurringSeriesFor(event);
    if (recurring) {
      if (pinnedEventIds.includes(event.id)) setEventPinned(event.id, false);
      addManualSeries(recurring);
      return;
    }

    setEventPinned(event.id, true, "start");
    addEntry(
      { kind: "event", event, announceReady: true },
      { placement: "start" },
    );
  }

  function addManualSeries(series: Series): void {
    status = `Loading ${seriesLabel(series)}…`;
    setSeriesPinned(series.id, true, "start");
    addEntry(
      { kind: "series", series, announceReady: true },
      { placement: "start" },
    );
  }

  async function recurringSeriesFor(event: Event): Promise<Series | null> {
    // Opening a single-market recurring event also opens its series history.
    // Multi-market event slugs still select their own event card.
    if (event.markets.length !== 1) return null;

    for (const reference of event.series) {
      try {
        const series = await client.fetchSeries({
          id: reference.id,
        });
        if (series.recurrence?.trim()) return series;
      } catch (error) {
        console.warn(`Could not inspect series ${reference.id}:`, error);
      }
    }
    return null;
  }

  function removeEvent(entry: EventDashboardItem): void {
    dismissedDiscoveryIds.add(entry.event.id);
    persistDismissedDiscoveryIds();
    if (pinnedEventIds.includes(entry.event.id))
      setEventPinned(entry.event.id, false);
    removeEntry(entry);
    status = `Removed ${itemLabel(entry)}.`;
  }

  function removeSeries(entry: SeriesDashboardItem): void {
    if (pinnedSeriesIds.includes(entry.series.id))
      setSeriesPinned(entry.series.id, false);
    removeEntry(entry);
    status = `Removed ${itemLabel(entry)}.`;
  }

  function itemReady(entry: DashboardItem): void {
    if (entry.announceReady) status = `Added ${itemLabel(entry)}.`;
  }

  function itemFailed(entry: DashboardItem, message: string): void {
    removeEntry(entry);
    status = `Could not add ${itemLabel(entry)}: ${message}`;
  }

  async function loadPinnedEvent(eventId: EventId): Promise<void> {
    try {
      const event = await client.fetchEvent({ id: eventId });
      addEntry({ kind: "event", event, announceReady: false });
    } catch (error) {
      console.error(`Could not load event ${eventId}:`, error);
    }
  }

  async function loadPinnedSeries(seriesId: SeriesId): Promise<void> {
    try {
      const series = await client.fetchSeries({ id: seriesId });
      addEntry({ kind: "series", series, announceReady: false });
    } catch (error) {
      console.error(`Could not load series ${seriesId}:`, error);
    }
  }

  onMount(() => {
    const resized = () => {
      reorder.finish();
      columnCount = columnLayout.count;
    };
    window.addEventListener("resize", resized);
    for (const seriesId of pinnedSeriesIds) void loadPinnedSeries(seriesId);
    for (const eventId of pinnedEventIds) void loadPinnedEvent(eventId);

    return () => {
      window.removeEventListener("resize", resized);
      reorder.finish();
      columnLayout.destroy();
    };
  });
</script>

<header class="dashboard-toolbar">
  <div class="dashboard-primary">
    <EventSearch
      {client}
      {status}
      {loadedEventIds}
      onchoose={(event) => void addManualEvent(event)}
      onchooseseries={addManualSeries}
      onstatus={(message) => (status = message)}
    />
    <div class="layout-columns" role="group" aria-label="Dashboard columns">
      <label for="dashboard-columns">Columns</label>
      <div class="layout-columns-controls">
        <button
          type="button"
          onclick={() => setColumnCount(columnCount - 1)}
          disabled={columnCount <= MIN_COLUMNS}
          aria-label="Use fewer columns">−</button
        >
        <input
          id="dashboard-columns"
          type="number"
          min={MIN_COLUMNS}
          step="1"
          inputmode="numeric"
          value={columnCount}
          aria-label="Dashboard column count"
          onchange={(event) => commitColumnCount(event.currentTarget)}
        />
        <button
          type="button"
          onclick={() => setColumnCount(columnCount + 1)}
          aria-label="Use more columns">+</button
        >
      </div>
    </div>
  </div>
  <PressureLegend />
</header>

<div class="grid" class:grid--dragging={draggingKey !== null}>
  {#each orderedEntries as entry (itemKey(entry))}
    <div
      class="grid-item"
      class:grid-item--dragging={draggingKey === itemKey(entry)}
      data-layout-key={itemKey(entry)}
      use:masonryItem
    >
      {#if entry.kind === "series"}
        <SeriesCard
          series={entry.series}
          pinned={pinnedSeriesIds.includes(entry.series.id)}
          onpin={(pinned) => setSeriesPinned(entry.series.id, pinned, "end")}
          onremove={() => removeSeries(entry)}
          onready={() => itemReady(entry)}
          onfailure={(message) => itemFailed(entry, message)}
          onreorderstart={(event) => reorder.start(event, itemKey(entry))}
          onreorderstep={(direction) =>
            reorder.step(
              itemKey(entry),
              direction,
              orderedEntries.map(itemKey),
            )}
        />
      {:else}
        <EventCard
          event={entry.event}
          pinned={pinnedEventIds.includes(entry.event.id)}
          onpin={(pinned) => setEventPinned(entry.event.id, pinned, "end")}
          onremove={() => removeEvent(entry)}
          onready={() => itemReady(entry)}
          onfailure={(message) => itemFailed(entry, message)}
          onreorderstart={(event) => reorder.start(event, itemKey(entry))}
          onreorderstep={(direction) =>
            reorder.step(
              itemKey(entry),
              direction,
              orderedEntries.map(itemKey),
            )}
        />
      {/if}
    </div>
  {/each}
</div>

<DiscoveryPanel
  {client}
  {pinnedSeriesIds}
  excludedEventIds={discoveryExcludedEventIds}
  onadd={(event) =>
    addEntry(
      { kind: "event", event, announceReady: false },
      { focusExisting: false },
    )}
/>
