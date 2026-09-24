<script lang="ts">
  import { onMount, tick } from "svelte";
  import EventCard from "./EventCard.svelte";
  import EventSearch from "./EventSearch.svelte";
  import PressureLegend from "./PressureLegend.svelte";
  import SeriesCard from "./SeriesCard.svelte";
  import type { CardReorderStart } from "./cardReorderSurface";
  import { findSeriesBySlug } from "../lib/seriesTimeline";
  import {
    DEFAULT_MIN_VOLUME,
    DEFAULT_RECENCY_DAYS,
    discoverEvents,
    parseDiscoveryTopics,
    validateDiscoveryFilters,
    type DiscoveryOrder,
  } from "../lib/eventDiscovery";
  import { setSharedTooltipSuppressed } from "../lib/sharedTooltip";
  import {
    dashboardOrderForPointer,
    type DashboardDragSnapshot,
  } from "./dashboardReorder";
  import {
    eventLabel,
    eventSlug,
    normalizePinnedSeriesIds,
    normalizePinnedSlugs,
    pinState,
    seriesLabel,
    toEventSlug,
    type EventDashboardItem,
    type DashboardItem,
    type EventSlug,
    type PinState,
    type SeriesDashboardItem,
  } from "./model";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  const PINNED_STORAGE_KEY = "polymarket-book-vis:pinned-event-slugs:v1";
  const PINNED_SERIES_STORAGE_KEY = "polymarket-book-vis:pinned-series-ids:v1";
  const COLUMN_COUNT_STORAGE_KEY = "polymarket-book-vis:dashboard-columns:v1";
  const LAYOUT_ORDER_STORAGE_KEY = "polymarket-book-vis:dashboard-order:v1";
  // Keep the original storage keys so saved filters and dismissals survive
  // the move from regional discovery to general event discovery.
  const DISCOVERY_VOLUME_STORAGE_KEY =
    "polymarket-book-vis:regional-min-volume:v1";
  const DISCOVERY_DAYS_STORAGE_KEY = "polymarket-book-vis:regional-days:v1";
  const DISMISSED_DISCOVERY_STORAGE_KEY =
    "polymarket-book-vis:dismissed-regional-events:v1";
  const MIN_COLUMNS = 1;

  const client = createPublicClient();

  let entries: DashboardItem[] = [];
  let pinnedSlugs: EventSlug[] = loadPinnedSlugs();
  let pinnedSeriesIds: string[] = loadPinnedSeriesIds();
  let layoutOrder = loadLayoutOrder(pinnedSlugs, pinnedSeriesIds);
  let columnCount = loadColumnCount();
  let draggingKey: string | null = null;
  let dragSnapshot: DashboardDragSnapshot | null = null;
  let status = "";
  let discoveryStatus = "";
  let discovering = false;
  let discoveryRun = 0;
  let discoveryTopics =
    localStorage.getItem("polymarket-book-vis:discovery-topics:v1") ?? "";
  let minLiquidity = loadDiscoveryNumber(
    "polymarket-book-vis:discovery-min-liquidity:v1",
    0,
    0,
    100_000_000,
  );
  let discoveryOrder: DiscoveryOrder = "createdAt";
  let minVolume = loadDiscoveryNumber(
    DISCOVERY_VOLUME_STORAGE_KEY,
    DEFAULT_MIN_VOLUME,
    0,
    100_000_000,
  );
  let recencyDays = loadDiscoveryNumber(
    DISCOVERY_DAYS_STORAGE_KEY,
    DEFAULT_RECENCY_DAYS,
    0,
    365,
  );
  let dismissedDiscoveryIds = loadDismissedDiscoveryIds();

  $: orderedEntries = orderDashboardItems(entries, layoutOrder);

  function loadDiscoveryNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max
      ? value
      : fallback;
  }

  function loadDismissedDiscoveryIds(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(DISMISSED_DISCOVERY_STORAGE_KEY) ?? "[]",
      );
      return Array.isArray(parsed)
        ? new Set(parsed.filter((id): id is string => typeof id === "string"))
        : new Set();
    } catch {
      return new Set();
    }
  }

  function persistDismissedDiscoveryIds(): void {
    localStorage.setItem(
      DISMISSED_DISCOVERY_STORAGE_KEY,
      JSON.stringify([...dismissedDiscoveryIds]),
    );
  }

  function loadPinnedSlugs(): EventSlug[] {
    try {
      const raw = localStorage.getItem(PINNED_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? normalizePinnedSlugs(parsed) : [];
    } catch {
      return [];
    }
  }

  function loadPinnedSeriesIds(): string[] {
    try {
      const raw = localStorage.getItem(PINNED_SERIES_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? normalizePinnedSeriesIds(parsed) : [];
    } catch {
      return [];
    }
  }

  function loadColumnCount(): number {
    try {
      const raw = localStorage.getItem(COLUMN_COUNT_STORAGE_KEY);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed) && parsed >= MIN_COLUMNS) return parsed;
      }
    } catch {
      // Fall back to the responsive default below.
    }

    if (window.innerWidth < 800) return 1;
    if (window.innerWidth < 1200) return 2;
    return 3;
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

  function loadLayoutOrder(
    eventPins: readonly EventSlug[],
    seriesPins: readonly string[],
  ): string[] {
    try {
      const raw = localStorage.getItem(LAYOUT_ORDER_STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const seen = new Set<string>();
          return parsed.filter((value): value is string => {
            if (
              typeof value !== "string" ||
              seen.has(value) ||
              (!value.startsWith("event:") && !value.startsWith("series:"))
            )
              return false;
            seen.add(value);
            return true;
          });
        }
      }
    } catch {
      // Fall through to the legacy pin ordering below.
    }

    return [
      ...seriesPins.map((id) => `series:${id}`),
      ...eventPins.map((slug) => `event:${slug}`),
    ];
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

    draggingKey = key;
    dragSnapshot = {
      order: visibleOrder,
      items,
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
    if (!draggingKey || !dragSnapshot) return;

    event.preventDefault();
    event.stopPropagation();

    const nextVisible = dashboardOrderForPointer(dragSnapshot, draggingKey, {
      x: event.clientX,
      y: event.clientY,
    });
    const visible = new Set(dragSnapshot.order);
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

  function finishReorder(): void {
    window.removeEventListener("pointermove", moveReorder, true);
    window.removeEventListener("pointerup", finishReorder, true);
    window.removeEventListener("pointercancel", finishReorder, true);
    if (draggingKey) persistLayoutOrder();
    draggingKey = null;
    dragSnapshot = null;
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

  function masonryItem(node: HTMLElement): { destroy(): void } {
    let frame = 0;
    let canvasHeight = "";

    const measure = (): void => {
      const grid = node.parentElement;
      if (!grid) return;

      const styles = getComputedStyle(grid);
      const rowHeight = Number.parseFloat(styles.gridAutoRows);
      const rowGap = Number.parseFloat(styles.rowGap);
      if (!Number.isFinite(rowHeight) || !Number.isFinite(rowGap)) return;

      // Break the stretch chain while measuring. Otherwise the rounded row
      // allocation becomes the next measurement (or collapses a flex chart).
      const card = node.querySelector<HTMLElement>(":scope > .card");
      const content = card?.querySelector<HTMLElement>(":scope > .cpv-wrap");
      const stage = content?.querySelector<HTMLElement>(
        ":scope > .cpv-chart-stage",
      );
      const canvas = stage?.querySelector<HTMLElement>(
        ":scope > .cpv-canvas-wrap",
      );
      node.style.alignSelf = "start";
      node.style.gridRowEnd = "auto";
      if (card) card.style.height = "auto";
      if (content) content.style.height = "auto";
      if (stage) stage.style.flex = "none";
      if (canvas) canvas.style.flex = "none";
      const naturalCardHeight = node.getBoundingClientRect().height;
      const span = Math.max(
        1,
        Math.ceil((naturalCardHeight + rowGap) / (rowHeight + rowGap)),
      );
      node.style.gridRowEnd = `span ${span}`;
      node.style.alignSelf = "";
      if (card) card.style.height = "";
      if (content) content.style.height = "";
      if (stage) stage.style.flex = "";
      if (canvas) canvas.style.flex = "";
    };

    const scheduleMeasure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    const mutations = new MutationObserver((records) => {
      const nextCanvasHeight =
        node.querySelector<HTMLElement>(".cpv-canvas-wrap")?.style.height ?? "";
      if (
        records.some(
          (record) =>
            record.type === "childList" || record.attributeName === "hidden",
        ) ||
        nextCanvasHeight !== canvasHeight
      ) {
        canvasHeight = nextCanvasHeight;
        scheduleMeasure();
      }
    });
    mutations.observe(node, {
      attributes: true,
      attributeFilter: ["style", "hidden"],
      childList: true,
      subtree: true,
    });
    scheduleMeasure();

    return {
      destroy() {
        cancelAnimationFrame(frame);
        observer.disconnect();
        mutations.disconnect();
      },
    };
  }

  function persistPinnedSlugs(next: readonly EventSlug[]): void {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
  }

  function persistPinnedSeriesIds(next: readonly string[]): void {
    localStorage.setItem(PINNED_SERIES_STORAGE_KEY, JSON.stringify(next));
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
      localStorage.setItem(
        "polymarket-book-vis:discovery-topics:v1",
        discoveryTopics,
      );
      localStorage.setItem(
        "polymarket-book-vis:discovery-min-liquidity:v1",
        String(minLiquidity),
      );
      const events = await discoverEvents(
        client,
        filters,
        new Set([
          ...dismissedDiscoveryIds,
          ...entries
            .filter((entry): entry is EventDashboardItem => entry.kind === "event")
            .map((entry) => String(entry.event.id)),
        ]),
        new Set(pinnedSlugs),
        Date.now(),
        new Set(pinnedSeriesIds),
      );
      if (run !== discoveryRun) return;

      let added = 0;
      for (const event of events) if (addEvent(event, false, false)) added++;
      discoveryStatus = added
        ? `Added ${added} ${added === 1 ? "event" : "events"}. Pin any you want to keep.`
        : "No new matches in the first 150 results. Try broader filters or another sort.";
    } catch (error) {
      if (run === discoveryRun)
        discoveryStatus = `Discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
    } finally {
      if (run === discoveryRun) discovering = false;
    }
  }

  function setPinned(
    slug: EventSlug,
    pinned: boolean,
    placement: "start" | "end" = "end",
  ): void {
    const without = pinnedSlugs.filter((candidate) => candidate !== slug);
    pinnedSlugs = pinned
      ? placement === "start"
        ? [slug, ...without]
        : [...without, slug]
      : without;
    persistPinnedSlugs(pinnedSlugs);
  }

  function setSeriesPinned(
    seriesId: string,
    pinned: boolean,
    placement: "start" | "end" = "end",
  ): void {
    const without = pinnedSeriesIds.filter(
      (candidate) => candidate !== seriesId,
    );
    pinnedSeriesIds = pinned
      ? placement === "start"
        ? [seriesId, ...without]
        : [...without, seriesId]
      : without;
    persistPinnedSeriesIds(pinnedSeriesIds);
  }

  function addEvent(
    event: Event,
    announceLifecycle: boolean,
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

    const entry: EventDashboardItem = {
      kind: "event",
      event,
      announceLifecycle,
    };
    rememberLayoutKey(itemKey(entry));
    entries = [...entries, entry];
    return true;
  }

  function addSeries(series: Series, announceLifecycle: boolean): boolean {
    const seriesId = String(series.id);
    const existing = entries.find(
      (entry) => entry.kind === "series" && String(entry.series.id) === seriesId,
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
      announceLifecycle,
    };
    rememberLayoutKey(itemKey(entry));
    entries = [...entries, entry];
    return true;
  }

  async function addManualEvent(event: Event): Promise<void> {
    status = `Loading ${eventLabel(event)}…`;
    if (dismissedDiscoveryIds.delete(String(event.id)))
      persistDismissedDiscoveryIds();

    const recurring = await recurringSeriesFor(event);
    if (recurring) {
      const occurrenceSlug = eventSlug(event);
      if (occurrenceSlug && pinnedSlugs.includes(occurrenceSlug))
        setPinned(occurrenceSlug, false);
      addManualSeries(recurring);
      return;
    }

    const slug = eventSlug(event);
    if (slug) {
      setPinned(slug, true, "start");
      rememberLayoutKey(`event:${slug}`, "start");
    }
    addEvent(event, true);
  }

  function addManualSeries(series: Series): void {
    status = `Loading ${seriesLabel(series)}…`;
    const legacySlug = toEventSlug(series.slug);
    if (legacySlug && pinnedSlugs.includes(legacySlug))
      setPinned(legacySlug, false);
    const seriesId = String(series.id);
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
          id: String(reference.id),
        });
        if (series.recurrence?.trim()) return series;
      } catch (error) {
        console.warn(
          `Could not inspect series ${String(reference.id)}:`,
          error,
        );
      }
    }
    return null;
  }

  function togglePin(state: PinState): void {
    if (state.kind === "unavailable") return;
    setPinned(state.slug, state.kind !== "pinned", "end");
  }

  function removeEvent(entry: EventDashboardItem): void {
    dismissedDiscoveryIds.add(String(entry.event.id));
    persistDismissedDiscoveryIds();
    const slug = eventSlug(entry.event);
    if (slug && pinnedSlugs.includes(slug)) setPinned(slug, false);
    forgetLayoutKey(itemKey(entry));
    entries = entries.filter(
      (candidate) =>
        candidate.kind === "series" || candidate.event.id !== entry.event.id,
    );
    status = `Removed ${eventLabel(entry.event)}.`;
  }

  function removeSeries(entry: SeriesDashboardItem): void {
    const seriesId = String(entry.series.id);
    if (pinnedSeriesIds.includes(seriesId)) setSeriesPinned(seriesId, false);
    forgetLayoutKey(itemKey(entry));
    entries = entries.filter(
      (candidate) =>
        candidate.kind === "event" || String(candidate.series.id) !== seriesId,
    );
    status = `Removed ${seriesLabel(entry.series)}.`;
  }

  function itemReady(entry: DashboardItem): void {
    if (!entry.announceLifecycle) return;
    status =
      entry.kind === "series"
        ? `Added ${seriesLabel(entry.series)}.`
        : `Added ${eventLabel(entry.event)}.`;
  }

  function itemFailed(entry: DashboardItem, message: string): void {
    if (entry.kind === "series") {
      const seriesId = String(entry.series.id);
      forgetLayoutKey(itemKey(entry));
      entries = entries.filter(
        (candidate) =>
          candidate.kind === "event" ||
          String(candidate.series.id) !== seriesId,
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

  async function loadPinned(slug: EventSlug): Promise<void> {
    try {
      const series = await findSeriesBySlug(client, slug);
      if (series?.recurrence?.trim()) {
        setPinned(slug, false);
        setSeriesPinned(String(series.id), true, "end");
        addSeries(series, false);
        return;
      }
    } catch (error) {
      console.warn(`Could not inspect pinned slug ${slug} as a series:`, error);
    }

    try {
      const event = await client.fetchEvent({ slug });
      addEvent(event, false);
    } catch (error) {
      console.error(`Could not load ${slug}:`, error);
    }
  }

  async function loadPinnedSeries(seriesId: string): Promise<void> {
    try {
      const series = await client.fetchSeries({ id: seriesId });
      addSeries(series, false);
    } catch (error) {
      console.error(`Could not load series ${seriesId}:`, error);
    }
  }

  onMount(() => {
    for (const seriesId of pinnedSeriesIds) void loadPinnedSeries(seriesId);
    for (const slug of pinnedSlugs) void loadPinned(slug);

    return () => {
      discoveryRun++;
      finishReorder();
    };
  });

  function orderDashboardItems(
    items: readonly DashboardItem[],
    order: readonly string[],
  ): DashboardItem[] {
    const ranks = new Map(order.map((key, index) => [key, index]));
    const insertion = new Map(
      items.map((entry, index) => [itemKey(entry), index]),
    );

    return [...items].sort((a, b) => {
      const aRank = ranks.get(itemKey(a));
      const bRank = ranks.get(itemKey(b));
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return (
        (insertion.get(itemKey(a)) ?? 0) - (insertion.get(itemKey(b)) ?? 0)
      );
    });
  }

  function itemKey(entry: DashboardItem): string {
    if (entry.kind === "series") return `series:${String(entry.series.id)}`;
    return `event:${eventSlug(entry.event) ?? entry.event.id}`;
  }
</script>

<header class="dashboard-toolbar">
  <div class="dashboard-primary">
    <EventSearch
      {client}
      {status}
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
          {client}
          pinned={pinnedSeriesIds.includes(String(entry.series.id))}
          onpin={(pinned) =>
            setSeriesPinned(String(entry.series.id), pinned, "end")}
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
          pin={pinState(entry.event, pinnedSlugs)}
          onpin={togglePin}
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
          max="100000000"
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
          max="100000000"
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
          <option value={365}>1 year</option>
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
      Adds up to 8 events per click, scanning up to 150 results. Already loaded
      or dismissed events are skipped.
    </p>
    <p class="discovery-status" role="status">{discoveryStatus}</p>
  </form>
</details>
