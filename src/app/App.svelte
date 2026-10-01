<script lang="ts">
  import { onMount, tick } from "svelte";
  import EventCard from "./events/EventCard.svelte";
  import EventSearch from "./discovery/EventSearch.svelte";
  import PressureLegend from "./shared/PressureLegend.svelte";
  import SeriesCard from "./series/SeriesCard.svelte";
  import type { CardReorderStart } from "./dashboard/cardReorderSurface";
  import {
    MAX_DISCOVERED_EVENTS,
    MAX_DISCOVERY_RESULTS,
    MAX_DISCOVERY_AMOUNT,
    MAX_DISCOVERY_RECENCY_DAYS,
    DEFAULT_MIN_VOLUME,
    DEFAULT_RECENCY_DAYS,
    discoverEvents,
    parseDiscoveryTopics,
    validateDiscoveryFilters,
    type DiscoveryOrder,
  } from "../domain/discovery/eventDiscovery";
  import { setSharedTooltipSuppressed } from "../rendering/sharedTooltip";
  import {
    dashboardDragScrollVelocity,
    dashboardOrderForPointer,
    type DashboardDragSnapshot,
  } from "./dashboard/dashboardReorder";
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
    DISCOVERY_TOPICS_STORAGE_KEY,
    DISCOVERY_LIQUIDITY_STORAGE_KEY,
    PINNED_EVENT_IDS_STORAGE_KEY,
    PINNED_SERIES_IDS_STORAGE_KEY,
    COLUMN_COUNT_STORAGE_KEY,
    LAYOUT_ORDER_STORAGE_KEY,
    DISCOVERY_VOLUME_STORAGE_KEY,
    DISCOVERY_DAYS_STORAGE_KEY,
    DISMISSED_DISCOVERY_STORAGE_KEY,
    MIN_COLUMNS,
    loadDiscoveryNumber,
    loadDismissedDiscoveryIds,
    loadStoredIds,
    loadColumnCount,
    loadLayoutOrder,
    persistIds,
  } from "./dashboard/dashboardStorage";
  import { masonryItem } from "./dashboard/masonryItem";

  const INITIAL_SCROLL_FRAME_MS = 16;
  const MAX_SCROLL_FRAME_MS = 32;

  const client = createPublicClient();

  let entries: DashboardItem[] = [];
  let pinnedEventIds = loadStoredIds<EventId>(PINNED_EVENT_IDS_STORAGE_KEY);
  let pinnedSeriesIds = loadStoredIds<SeriesId>(PINNED_SERIES_IDS_STORAGE_KEY);
  let layoutOrder = loadLayoutOrder(pinnedEventIds, pinnedSeriesIds);
  let columnCount = loadColumnCount();
  interface DragSession {
    readonly key: string;
    readonly snapshot: DashboardDragSnapshot;
    pointer: { x: number; y: number };
  }
  let drag: DragSession | null = null;
  let dragScrollFrame: number | null = null;
  let dragScrollFrameTime: number | null = null;
  let status = "";
  let discoveryStatus = "";
  let discovering = false;
  let discoveryRun = 0;
  let discoveryTopics =
    localStorage.getItem(DISCOVERY_TOPICS_STORAGE_KEY) ?? "";
  let minLiquidity = loadDiscoveryNumber(
    DISCOVERY_LIQUIDITY_STORAGE_KEY,
    0,
    0,
    MAX_DISCOVERY_AMOUNT,
  );
  let discoveryOrder: DiscoveryOrder = "createdAt";
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
  let dismissedDiscoveryIds = loadDismissedDiscoveryIds();

  $: orderedEntries = orderDashboardItems(entries, layoutOrder);
  $: loadedEventIds = new Set(
    entries.flatMap((entry) =>
      entry.kind === "event" ? [entry.event.id] : [],
    ),
  );

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

  function startReorder(start: CardReorderStart, key: string): void {
    const { event, origin, surface } = start;
    event.preventDefault();
    finishReorder();

    const grid = document.querySelector<HTMLElement>(".grid");
    if (!grid) return;

    const nodes = Array.from(
      grid.querySelectorAll<HTMLElement>(".grid-item[data-layout-key]"),
    );
    const draggedNode = nodes.find((node) => node.dataset.layoutKey === key);
    if (!draggedNode) return;

    const gridStyles = getComputedStyle(grid);
    const gridRect = grid.getBoundingClientRect();
    const draggedRect = draggedNode.getBoundingClientRect();
    const rowHeight = Number.parseFloat(gridStyles.gridAutoRows);
    const rowGap = Number.parseFloat(gridStyles.rowGap);
    const columnGap = Number.parseFloat(gridStyles.columnGap);
    const paddingLeft = Number.parseFloat(gridStyles.paddingLeft);
    const paddingTop = Number.parseFloat(gridStyles.paddingTop);
    if (
      !Number.isFinite(rowHeight) ||
      !Number.isFinite(rowGap) ||
      !Number.isFinite(columnGap) ||
      !Number.isFinite(paddingLeft) ||
      !Number.isFinite(paddingTop)
    )
      return;

    const items = nodes.flatMap((node) => {
      const itemKey = node.dataset.layoutKey;
      if (!itemKey) return [];

      const rect = node.getBoundingClientRect();
      return [
        {
          key: itemKey,
          height: rect.height,
          rowSpan: Math.max(
            1,
            Math.ceil((rect.height + rowGap) / (rowHeight + rowGap)),
          ),
        },
      ];
    });
    const visibleKeys = new Set(items.map((item) => item.key));
    const visibleOrder = [
      ...layoutOrder.filter((itemKey) => visibleKeys.has(itemKey)),
      ...items
        .map((item) => item.key)
        .filter((itemKey) => !layoutOrder.includes(itemKey)),
    ];

    const snapshot: DashboardDragSnapshot = {
      order: visibleOrder,
      items,
      viewportScrollY: window.scrollY,
      grid: {
        left: gridRect.left + paddingLeft,
        top: gridRect.top + paddingTop,
        columnWidth: draggedRect.width,
        columnGap,
        rowHeight,
        rowGap,
        columnCount,
      },
      grabOffset: {
        x: origin.x - draggedRect.left,
        y: origin.y - draggedRect.top,
      },
    };

    drag = { key, snapshot, pointer: { x: event.clientX, y: event.clientY } };

    try {
      surface.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the pointer ended synchronously.
    }

    setSharedTooltipSuppressed(true);
    window.addEventListener("pointermove", moveReorder, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", finishReorder, {
      capture: true,
      once: true,
    });
    window.addEventListener("pointercancel", finishReorder, {
      capture: true,
      once: true,
    });
    moveReorder(event);
  }

  function moveReorder(event: PointerEvent): void {
    if (!drag) return;

    event.preventDefault();
    event.stopPropagation();

    drag.pointer = { x: event.clientX, y: event.clientY };
    applyReorderAtPointer(drag.pointer);
    updateDragAutoScroll();
  }

  function applyReorderAtPointer(pointer: { x: number; y: number }): void {
    if (!drag) return;

    const nextVisible = dashboardOrderForPointer(
      drag.snapshot,
      drag.key,
      {
        x: pointer.x,
        y: pointer.y,
      },
      window.scrollY,
    );
    const visible = new Set(drag.snapshot.order);
    let nextIndex = 0;
    const next = layoutOrder.map((itemKey) =>
      visible.has(itemKey) ? (nextVisible[nextIndex++] ?? itemKey) : itemKey,
    );

    if (
      next.length === layoutOrder.length &&
      next.every((itemKey, index) => itemKey === layoutOrder[index])
    )
      return;

    layoutOrder = next;
  }

  function updateDragAutoScroll(): void {
    if (!drag) return;
    if (dashboardDragScrollVelocity(drag.pointer.y, window.innerHeight) === 0) {
      stopDragAutoScroll();
      return;
    }
    if (dragScrollFrame === null)
      dragScrollFrame = requestAnimationFrame(runDragAutoScroll);
  }

  function runDragAutoScroll(time: number): void {
    dragScrollFrame = null;
    if (!drag) return;

    const velocity = dashboardDragScrollVelocity(
      drag.pointer.y,
      window.innerHeight,
    );
    if (velocity === 0) {
      dragScrollFrameTime = null;
      return;
    }

    const elapsedMs =
      dragScrollFrameTime === null
        ? INITIAL_SCROLL_FRAME_MS
        : Math.min(
            MAX_SCROLL_FRAME_MS,
            Math.max(0, time - dragScrollFrameTime),
          );
    dragScrollFrameTime = time;
    const before = window.scrollY;
    window.scrollBy(0, (velocity * elapsedMs) / 1_000);

    if (window.scrollY === before) {
      dragScrollFrameTime = null;
      return;
    }

    applyReorderAtPointer(drag.pointer);
    dragScrollFrame = requestAnimationFrame(runDragAutoScroll);
  }

  function stopDragAutoScroll(): void {
    if (dragScrollFrame !== null) cancelAnimationFrame(dragScrollFrame);
    dragScrollFrame = null;
    dragScrollFrameTime = null;
  }

  function finishReorder(): void {
    window.removeEventListener("pointermove", moveReorder, true);
    window.removeEventListener("pointerup", finishReorder, true);
    window.removeEventListener("pointercancel", finishReorder, true);
    if (drag) persistLayoutOrder();
    stopDragAutoScroll();
    drag = null;
    setSharedTooltipSuppressed(false);
  }

  function stepReorder(key: string, direction: -1 | 1): void {
    const visibleKeys = orderedEntries.map(itemKey);
    const index = visibleKeys.indexOf(key);
    const neighbor = visibleKeys[index + direction];
    if (index < 0 || !neighbor) return;

    const from = layoutOrder.indexOf(key);
    const to = layoutOrder.indexOf(neighbor);
    if (from < 0 || to < 0) return;

    const next = [...layoutOrder];
    [next[from], next[to]] = [next[to]!, next[from]!];
    layoutOrder = next;
    persistLayoutOrder();
  }

  async function refreshDiscoveryEvents(): Promise<void> {
    if (discovering) return;
    const run = ++discoveryRun;
    discovering = true;
    discoveryStatus = "Finding matching events…";

    try {
      const filters = {
        topics: parseDiscoveryTopics(discoveryTopics),
        minVolume,
        minLiquidity,
        recencyDays,
        order: discoveryOrder,
      };
      validateDiscoveryFilters(filters);
      localStorage.setItem(DISCOVERY_VOLUME_STORAGE_KEY, String(minVolume));
      localStorage.setItem(DISCOVERY_DAYS_STORAGE_KEY, String(recencyDays));
      localStorage.setItem(DISCOVERY_TOPICS_STORAGE_KEY, discoveryTopics);
      localStorage.setItem(
        DISCOVERY_LIQUIDITY_STORAGE_KEY,
        String(minLiquidity),
      );
      const events = await discoverEvents(
        client,
        filters,
        new Set([
          ...dismissedDiscoveryIds,
          ...pinnedEventIds,
          ...entries
            .filter(
              (entry): entry is EventDashboardItem => entry.kind === "event",
            )
            .map((entry) => entry.event.id),
        ]),
        Date.now(),
        new Set(pinnedSeriesIds),
      );
      if (run !== discoveryRun) return;

      let added = 0;
      for (const event of events) if (addEvent(event, false, false)) added++;
      discoveryStatus = added
        ? `Added ${added} ${added === 1 ? "event" : "events"}. Pin any you want to keep.`
        : `No new matches in the first ${MAX_DISCOVERY_RESULTS} results. Try broader filters or another sort.`;
    } catch (error) {
      if (run === discoveryRun)
        discoveryStatus = `Discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
    } finally {
      if (run === discoveryRun) discovering = false;
    }
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
      discoveryRun++;
      finishReorder();
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
  <PressureLegend {client} />
</header>

<div
  class="grid"
  class:grid--dragging={drag !== null}
  style={`--dashboard-columns: ${columnCount}`}
>
  {#each orderedEntries as entry (itemKey(entry))}
    <div
      class="grid-item"
      class:grid-item--dragging={drag?.key === itemKey(entry)}
      data-layout-key={itemKey(entry)}
      use:masonryItem
    >
      {#if entry.kind === "series"}
        <SeriesCard
          series={entry.series}
          {client}
          pinned={pinnedSeriesIds.includes(entry.series.id)}
          onpin={(pinned) => setSeriesPinned(entry.series.id, pinned, "end")}
          onremove={() => removeSeries(entry)}
          onready={() => itemReady(entry)}
          onfailure={(message) => itemFailed(entry, message)}
          onreorderstart={(event) => startReorder(event, itemKey(entry))}
          onreorderstep={(direction) => stepReorder(itemKey(entry), direction)}
        />
      {:else}
        <EventCard
          event={entry.event}
          {client}
          pinned={pinnedEventIds.includes(entry.event.id)}
          onpin={(pinned) => setEventPinned(entry.event.id, pinned, "end")}
          onremove={() => removeEvent(entry)}
          onready={() => itemReady(entry)}
          onfailure={(message) => itemFailed(entry, message)}
          onreorderstart={(event) => startReorder(event, itemKey(entry))}
          onreorderstep={(direction) => stepReorder(itemKey(entry), direction)}
        />
      {/if}
    </div>
  {/each}
</div>

<details class="event-discovery">
  <summary>Discover events</summary>
  <p>
    Not finding what you’re looking for? Browse open, tradable events from any
    topic.
  </p>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void refreshDiscoveryEvents();
    }}
  >
    <fieldset disabled={discovering}>
      <label class="discovery-topics">
        Topics
        <input
          type="text"
          placeholder="All topics"
          bind:value={discoveryTopics}
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
        <select bind:value={discoveryOrder}>
          <option value="createdAt">Newest first</option>
          <option value="volume">Highest total volume</option>
          <option value="volume24hr">Highest 24h volume</option>
          <option value="liquidity">Highest liquidity</option>
        </select>
      </label>
      <button type="submit"
        >{discovering ? "Loading…" : "Load more events"}</button
      >
    </fieldset>
    <p class="discovery-help">
      Adds up to {MAX_DISCOVERED_EVENTS} events per click, scanning up to {MAX_DISCOVERY_RESULTS}
      results. Already loaded or dismissed events are skipped.
    </p>
    <p class="discovery-status" role="status">{discoveryStatus}</p>
  </form>
</details>
