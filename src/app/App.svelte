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
    orderDashboardItems,
    eventLabel,
    seriesLabel,
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
    COLUMN_COUNT_STORAGE_KEY,
    LAYOUT_ORDER_STORAGE_KEY,
    DISMISSED_DISCOVERY_STORAGE_KEY,
    MIN_COLUMNS,
    loadDismissedDiscoveryIds,
    loadStoredIds,
    loadColumnCount,
    loadLayoutOrder,
    persistIds,
  } from "./dashboard/dashboardStorage";
  import { masonryItem } from "./dashboard/masonryItem";

  const client = createPublicClient();
  provideVisualizationContext(client);

  let entries: DashboardItem[] = [];
  let pinnedEventIds = loadStoredIds<EventId>(PINNED_EVENT_IDS_STORAGE_KEY);
  let pinnedSeriesIds = loadStoredIds<SeriesId>(PINNED_SERIES_IDS_STORAGE_KEY);
  let layoutOrder = loadLayoutOrder(pinnedEventIds, pinnedSeriesIds);
  let columnCount = loadColumnCount();
  let draggingKey: string | null = null;
  let status = "";
  let dismissedDiscoveryIds = loadDismissedDiscoveryIds();
  const reorder = new DashboardReorderController({
    getOrder: () => layoutOrder,
    getColumnCount: () => columnCount,
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
    if (!Number.isFinite(next)) return;
    columnCount = Math.max(MIN_COLUMNS, Math.round(next));
    localStorage.setItem(COLUMN_COUNT_STORAGE_KEY, String(columnCount));
  }

  function commitColumnCount(input: HTMLInputElement): void {
    const value = Number(input.value);
    if (
      input.value.trim() !== "" &&
      Number.isInteger(value) &&
      value >= MIN_COLUMNS
    )
      setColumnCount(value);
    input.value = String(columnCount);
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
    const without = pinnedEventIds.filter((candidate) => candidate !== id);
    pinnedEventIds = pinned
      ? placement === "start"
        ? [id, ...without]
        : [...without, id]
      : without;
    persistIds(PINNED_EVENT_IDS_STORAGE_KEY, pinnedEventIds);
  }

  function setSeriesPinned(
    id: SeriesId,
    pinned: boolean,
    placement: "start" | "end" = "end",
  ): void {
    const without = pinnedSeriesIds.filter((candidate) => candidate !== id);
    pinnedSeriesIds = pinned
      ? placement === "start"
        ? [id, ...without]
        : [...without, id]
      : without;
    persistIds(PINNED_SERIES_IDS_STORAGE_KEY, pinnedSeriesIds);
  }

  function addEvent(
    event: Event,
    announceReady: boolean,
    focusExisting = true,
  ): boolean {
    const existing = entries.find(
      (entry) => entry.kind === "event" && entry.event.id === event.id,
    );
    if (existing) {
      if (focusExisting) {
        status = `${eventLabel(event)} is already on the dashboard.`;
        void tick().then(() => {
          document
            .querySelector<HTMLElement>(
              `[data-event-id="${CSS.escape(event.id)}"]`,
            )
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
      return false;
    }

    const entry: EventDashboardItem = { kind: "event", event, announceReady };
    rememberLayoutKey(itemKey(entry));
    entries = [...entries, entry];
    return true;
  }

  function addSeries(series: Series, announceReady: boolean): boolean {
    const seriesId = series.id;
    const existing = entries.find(
      (entry) => entry.kind === "series" && entry.series.id === seriesId,
    );
    if (existing) {
      status = `${seriesLabel(series)} is already on the dashboard.`;
      void tick().then(() => {
        document
          .querySelector<HTMLElement>(
            `[data-series-id="${CSS.escape(seriesId)}"]`,
          )
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return false;
    }

    const entry: SeriesDashboardItem = {
      kind: "series",
      series,
      announceReady,
    };
    rememberLayoutKey(itemKey(entry));
    entries = [...entries, entry];
    return true;
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
    rememberLayoutKey(`event:${event.id}`, "start");
    addEvent(event, true);
  }

  function addManualSeries(series: Series): void {
    status = `Loading ${seriesLabel(series)}…`;
    const seriesId = series.id;
    setSeriesPinned(seriesId, true, "start");
    rememberLayoutKey(`series:${seriesId}`, "start");
    addSeries(series, true);
  }

  async function recurringSeriesFor(event: Event): Promise<Series | null> {
    // Series view currently means one recurring binary event per timeline row.
    // Multi-market events retain the ordinary event-card representation.
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
    forgetLayoutKey(itemKey(entry));
    entries = entries.filter(
      (candidate) =>
        candidate.kind === "series" || candidate.event.id !== entry.event.id,
    );
    status = `Removed ${eventLabel(entry.event)}.`;
  }

  function removeSeries(entry: SeriesDashboardItem): void {
    const seriesId = entry.series.id;
    if (pinnedSeriesIds.includes(seriesId)) setSeriesPinned(seriesId, false);
    forgetLayoutKey(itemKey(entry));
    entries = entries.filter(
      (candidate) =>
        candidate.kind === "event" || candidate.series.id !== seriesId,
    );
    status = `Removed ${seriesLabel(entry.series)}.`;
  }

  function itemReady(entry: DashboardItem): void {
    if (!entry.announceReady) return;
    status =
      entry.kind === "series"
        ? `Added ${seriesLabel(entry.series)}.`
        : `Added ${eventLabel(entry.event)}.`;
  }

  function itemFailed(entry: DashboardItem, message: string): void {
    if (entry.kind === "series") {
      const seriesId = entry.series.id;
      forgetLayoutKey(itemKey(entry));
      entries = entries.filter(
        (candidate) =>
          candidate.kind === "event" || candidate.series.id !== seriesId,
      );
      status = `Could not add ${seriesLabel(entry.series)}: ${message}`;
      return;
    }

    forgetLayoutKey(itemKey(entry));
    entries = entries.filter(
      (candidate) =>
        candidate.kind === "series" || candidate.event.id !== entry.event.id,
    );
    status = `Could not add ${eventLabel(entry.event)}: ${message}`;
  }

  async function loadPinnedEvent(eventId: EventId): Promise<void> {
    try {
      const event = await client.fetchEvent({ id: eventId });
      addEvent(event, false);
    } catch (error) {
      console.error(`Could not load event ${eventId}:`, error);
    }
  }

  async function loadPinnedSeries(seriesId: SeriesId): Promise<void> {
    try {
      const series = await client.fetchSeries({ id: seriesId });
      addSeries(series, false);
    } catch (error) {
      console.error(`Could not load series ${seriesId}:`, error);
    }
  }

  onMount(() => {
    for (const seriesId of pinnedSeriesIds) void loadPinnedSeries(seriesId);
    for (const eventId of pinnedEventIds) void loadPinnedEvent(eventId);

    return () => {
      reorder.finish();
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

<div
  class="grid"
  class:grid--dragging={draggingKey !== null}
  style={`--dashboard-columns: ${columnCount}`}
>
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
  onadd={(event) => addEvent(event, false, false)}
/>
