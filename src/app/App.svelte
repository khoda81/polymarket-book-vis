<script lang="ts">
  import { onMount, tick } from "svelte";
  import EventCard from "./EventCard.svelte";
  import EventSearch from "./EventSearch.svelte";
  import PressureLegend from "./PressureLegend.svelte";
  import {
    errorMessage,
    eventLabel,
    eventSlug,
    normalizePinnedSlugs,
    orderEntries,
    pinState,
    type DashboardEntry,
    type EventSlug,
    type PinState,
  } from "./model";
  import {
    createPublicClient,
    type Event,
  } from "@polymarket/client";

  const PINNED_STORAGE_KEY =
    "polymarket-book-vis:pinned-event-slugs:v1";

  const client = createPublicClient();

  let entries: DashboardEntry[] = [];
  let pinnedSlugs: EventSlug[] = loadPinnedSlugs();
  let status = "";

  $: orderedEntries = orderEntries(entries, pinnedSlugs);

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

  function persistPinnedSlugs(next: readonly EventSlug[]): void {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(next));
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

  function addEvent(event: Event, announceLifecycle: boolean): boolean {
    const existing = entries.find((entry) => entry.event.id === event.id);
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

    entries = [...entries, { event, announceLifecycle }];
    return true;
  }

  function addManualEvent(event: Event): void {
    const slug = eventSlug(event);
    if (slug) setPinned(slug, true, "start");
    status = `Loading ${eventLabel(event)}…`;
    addEvent(event, true);
  }

  function togglePin(state: PinState): void {
    if (state.kind === "unavailable") return;
    setPinned(state.slug, state.kind !== "pinned", "end");
  }

  function removeEvent(entry: DashboardEntry): void {
    const slug = eventSlug(entry.event);
    if (slug && pinnedSlugs.includes(slug)) setPinned(slug, false);
    entries = entries.filter(
      (candidate) => candidate.event.id !== entry.event.id,
    );
    status = `Removed ${eventLabel(entry.event)}.`;
  }

  function chartReady(entry: DashboardEntry): void {
    if (entry.announceLifecycle)
      status = `Added ${eventLabel(entry.event)}.`;
  }

  function chartFailed(entry: DashboardEntry, message: string): void {
    entries = entries.filter(
      (candidate) => candidate.event.id !== entry.event.id,
    );
    status = `Could not add ${eventLabel(entry.event)}: ${message}`;
  }

  async function loadPinned(slug: EventSlug): Promise<void> {
    try {
      const event = await client.fetchEvent({ slug });
      addEvent(event, false);
    } catch (error) {
      console.error(`Could not load ${slug}:`, error);
    }
  }

  onMount(() => {
    for (const slug of pinnedSlugs) void loadPinned(slug);
  });
</script>

<header class="dashboard-toolbar">
  <EventSearch
    {client}
    {status}
    onchoose={addManualEvent}
    onstatus={(message) => (status = message)}
  />

  <div class="dashboard-meta">
    <PressureLegend />
  </div>

</header>

<div class="grid">
  {#each orderedEntries as entry (entry.event.id)}
    <EventCard
      event={entry.event}
      {client}
      pin={pinState(entry.event, pinnedSlugs)}
      onpin={togglePin}
      onremove={() => removeEvent(entry)}
      onready={() => chartReady(entry)}
      onfailure={(message) => chartFailed(entry, message)}
    />
  {/each}
</div>
