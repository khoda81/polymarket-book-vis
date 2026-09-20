<script lang="ts">
  import { onMount, tick } from "svelte";
  import EventCard from "./EventCard.svelte";
  import EventSearch from "./EventSearch.svelte";
  import PressureLegend from "./PressureLegend.svelte";
  import SeriesCard from "./SeriesCard.svelte";
  import { findSeriesBySlug } from "../lib/seriesTimeline";
  import {
    eventLabel,
    eventSlug,
    isSeriesEntry,
    normalizePinnedSeriesIds,
    normalizePinnedSlugs,
    pinState,
    seriesLabel,
    toEventSlug,
    type DashboardEntry,
    type DashboardItem,
    type EventSlug,
    type PinState,
    type SeriesDashboardEntry,
  } from "./model";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  const PINNED_STORAGE_KEY =
    "polymarket-book-vis:pinned-event-slugs:v1";
  const PINNED_SERIES_STORAGE_KEY =
    "polymarket-book-vis:pinned-series-ids:v1";
  const COLUMN_COUNT_STORAGE_KEY =
    "polymarket-book-vis:dashboard-columns:v1";
  const MIN_COLUMNS = 1;
  const MAX_COLUMNS = 6;

  const client = createPublicClient();

  let entries: DashboardItem[] = [];
  let pinnedSlugs: EventSlug[] = loadPinnedSlugs();
  let pinnedSeriesIds: string[] = loadPinnedSeriesIds();
  let columnCount = loadColumnCount();
  let status = "";

  $: orderedEntries = orderDashboardItems(
    entries,
    pinnedSlugs,
    pinnedSeriesIds,
  );

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
      return Array.isArray(parsed)
        ? normalizePinnedSeriesIds(parsed)
        : [];
    } catch {
      return [];
    }
  }

  function loadColumnCount(): number {
    try {
      const raw = localStorage.getItem(COLUMN_COUNT_STORAGE_KEY);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isInteger(parsed))
          return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, parsed));
      }
    } catch {
      // Fall back to the responsive default below.
    }

    if (window.innerWidth < 800) return 1;
    if (window.innerWidth < 1200) return 2;
    return 3;
  }

  function setColumnCount(next: number): void {
    columnCount = Math.min(
      MAX_COLUMNS,
      Math.max(MIN_COLUMNS, Math.round(next)),
    );
    localStorage.setItem(COLUMN_COUNT_STORAGE_KEY, String(columnCount));
  }

  function masonryItem(node: HTMLElement): { destroy(): void } {
    let frame = 0;

    const measure = (): void => {
      const grid = node.parentElement;
      if (!grid) return;

      const styles = getComputedStyle(grid);
      const rowHeight = Number.parseFloat(styles.gridAutoRows);
      const rowGap = Number.parseFloat(styles.rowGap);
      if (!Number.isFinite(rowHeight) || !Number.isFinite(rowGap)) return;

      const height = node.getBoundingClientRect().height;
      const span = Math.max(
        1,
        Math.ceil((height + rowGap) / (rowHeight + rowGap)),
      );
      node.style.gridRowEnd = `span ${span}`;
    };

    const scheduleMeasure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    scheduleMeasure();

    return {
      destroy() {
        cancelAnimationFrame(frame);
        observer.disconnect();
      },
    };
  }

  function persistPinnedSlugs(next: readonly EventSlug[]): void {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
  }

  function persistPinnedSeriesIds(next: readonly string[]): void {
    localStorage.setItem(
      PINNED_SERIES_STORAGE_KEY,
      JSON.stringify(next),
    );
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

  function addEvent(event: Event, announceLifecycle: boolean): boolean {
    const existing = entries.find(
      (entry) =>
        !isSeriesEntry(entry) && entry.event.id === event.id,
    );
    if (existing) {
      status = `${eventLabel(event)} is already on the dashboard.`;
      void tick().then(() => {
        document
          .querySelector<HTMLElement>(
            `[data-event-id="${CSS.escape(event.id)}"]`,
          )
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return false;
    }

    entries = [
      ...entries,
      { kind: "event", event, announceLifecycle },
    ];
    return true;
  }

  function addSeries(
    series: Series,
    announceLifecycle: boolean,
  ): boolean {
    const seriesId = String(series.id);
    const existing = entries.find(
      (entry) =>
        isSeriesEntry(entry) &&
        String(entry.series.id) === seriesId,
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

    entries = [
      ...entries,
      { kind: "series", series, announceLifecycle },
    ];
    return true;
  }

  async function addManualEvent(event: Event): Promise<void> {
    status = `Loading ${eventLabel(event)}…`;

    const recurring = await recurringSeriesFor(event);
    if (recurring) {
      const occurrenceSlug = eventSlug(event);
      if (occurrenceSlug && pinnedSlugs.includes(occurrenceSlug))
        setPinned(occurrenceSlug, false);
      addManualSeries(recurring);
      return;
    }

    const slug = eventSlug(event);
    if (slug) setPinned(slug, true, "start");
    addEvent(event, true);
  }

  function addManualSeries(series: Series): void {
    status = `Loading ${seriesLabel(series)}…`;
    const legacySlug = toEventSlug(series.slug);
    if (legacySlug && pinnedSlugs.includes(legacySlug))
      setPinned(legacySlug, false);
    setSeriesPinned(String(series.id), true, "start");
    addSeries(series, true);
  }

  async function recurringSeriesFor(
    event: Event,
  ): Promise<Series | null> {
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

  function removeEvent(entry: DashboardEntry): void {
    const slug = eventSlug(entry.event);
    if (slug && pinnedSlugs.includes(slug)) setPinned(slug, false);
    entries = entries.filter(
      (candidate) =>
        isSeriesEntry(candidate) ||
        candidate.event.id !== entry.event.id,
    );
    status = `Removed ${eventLabel(entry.event)}.`;
  }

  function removeSeries(entry: SeriesDashboardEntry): void {
    const seriesId = String(entry.series.id);
    if (pinnedSeriesIds.includes(seriesId))
      setSeriesPinned(seriesId, false);
    entries = entries.filter(
      (candidate) =>
        !isSeriesEntry(candidate) ||
        String(candidate.series.id) !== seriesId,
    );
    status = `Removed ${seriesLabel(entry.series)}.`;
  }

  function itemReady(entry: DashboardItem): void {
    if (!entry.announceLifecycle) return;
    status = isSeriesEntry(entry)
      ? `Added ${seriesLabel(entry.series)}.`
      : `Added ${eventLabel(entry.event)}.`;
  }

  function itemFailed(
    entry: DashboardItem,
    message: string,
  ): void {
    if (isSeriesEntry(entry)) {
      const seriesId = String(entry.series.id);
      entries = entries.filter(
        (candidate) =>
          !isSeriesEntry(candidate) ||
          String(candidate.series.id) !== seriesId,
      );
      status = `Could not add ${seriesLabel(entry.series)}: ${message}`;
      return;
    }

    entries = entries.filter(
      (candidate) =>
        isSeriesEntry(candidate) ||
        candidate.event.id !== entry.event.id,
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
    for (const seriesId of pinnedSeriesIds)
      void loadPinnedSeries(seriesId);
    for (const slug of pinnedSlugs) void loadPinned(slug);
  });

  function orderDashboardItems(
    items: readonly DashboardItem[],
    eventPins: readonly EventSlug[],
    seriesPins: readonly string[],
  ): DashboardItem[] {
    const pinRanks = new Map<string, number>();
    let rank = 0;
    for (const id of seriesPins)
      pinRanks.set(`series:${id}`, rank++);
    for (const slug of eventPins)
      pinRanks.set(`event:${slug}`, rank++);

    const insertion = new Map(
      items.map((entry, index) => [itemKey(entry), index]),
    );

    return [...items].sort((a, b) => {
      const aRank = pinRanks.get(itemKey(a));
      const bRank = pinRanks.get(itemKey(b));
      if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
      if (aRank !== undefined) return -1;
      if (bRank !== undefined) return 1;
      return (
        (insertion.get(itemKey(a)) ?? 0) -
        (insertion.get(itemKey(b)) ?? 0)
      );
    });
  }

  function itemKey(entry: DashboardItem): string {
    if (isSeriesEntry(entry))
      return `series:${String(entry.series.id)}`;
    return `event:${eventSlug(entry.event) ?? entry.event.id}`;
  }
</script>

<header class="dashboard-toolbar">
  <EventSearch
    {client}
    {status}
    onchoose={(event) => void addManualEvent(event)}
    onchooseseries={addManualSeries}
    onstatus={(message) => (status = message)}
  />

  <div class="dashboard-meta">
    <div class="layout-columns" aria-label="Dashboard columns">
      <button
        type="button"
        onclick={() => setColumnCount(columnCount - 1)}
        disabled={columnCount <= MIN_COLUMNS}
        aria-label="Use fewer columns"
      >−</button>
      <span>{columnCount} col{columnCount === 1 ? "" : "s"}</span>
      <button
        type="button"
        onclick={() => setColumnCount(columnCount + 1)}
        disabled={columnCount >= MAX_COLUMNS}
        aria-label="Use more columns"
      >+</button>
    </div>
    <PressureLegend />
  </div>
</header>

<div
  class="grid"
  style={`--dashboard-columns: ${columnCount}`}
>
  {#each orderedEntries as entry (itemKey(entry))}
    <div class="grid-item" use:masonryItem>
      {#if isSeriesEntry(entry)}
        <SeriesCard
          series={entry.series}
          {client}
          pinned={pinnedSeriesIds.includes(String(entry.series.id))}
          onpin={(pinned) =>
            setSeriesPinned(String(entry.series.id), pinned, "end")}
          onremove={() => removeSeries(entry)}
          onready={() => itemReady(entry)}
          onfailure={(message) => itemFailed(entry, message)}
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
        />
      {/if}
    </div>
  {/each}
</div>
