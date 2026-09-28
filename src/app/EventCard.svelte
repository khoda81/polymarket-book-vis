<script lang="ts">
  import { onMount } from "svelte";
  import ChartHost from "./ChartHost.svelte";
  import EventDescription from "./EventDescription.svelte";
  import EventHeader from "./EventHeader.svelte";
  import MarketRules from "./MarketRules.svelte";
  import {
    cardReorderSurface,
    reorderHandleClick,
    reorderHandleKeydown,
    type CardReorderStart,
  } from "./cardReorderSurface";
  import type { ConnectionStatus, ViewMode } from "../lib/chartState";
  import {
    flipAgeRowOrientation,
    inferAgeRowOrientation,
    type AgeRowOrientation,
  } from "../chart/ageStripOrientation";
  import { loadEventDetails, type EventDetails } from "../lib/eventDetails";
  import {
    loadStoredAgeRowOrientation,
    persistAgeRowOrientation,
  } from "./ageRowOrientationStorage";
  import type { EventMarketStatus } from "../lib/marketLifecycle";
  import { createPublicClient, type Event } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  type RuntimeState =
    | { readonly kind: "metadata-loading" }
    | {
        readonly kind: "chart-loading";
        readonly bundle: EventDetails;
        readonly connection: ConnectionStatus;
      }
    | {
        readonly kind: "ready";
        readonly bundle: EventDetails;
        readonly connection: ConnectionStatus;
      }
    | { readonly kind: "failed"; readonly message: string };

  export let event: Event;
  export let client: PublicClient;
  export let pinned: boolean;
  export let onpin: (pinned: boolean) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;
  export let onreorderstart: (start: CardReorderStart) => void;
  export let onreorderstep: (direction: -1 | 1) => void;

  let viewMode: ViewMode = "age";
  let ageRowOrientation: AgeRowOrientation =
    loadStoredAgeRowOrientation({ kind: "event", id: event.id }) ??
    inferAgeRowOrientation({
      sortBy: event.display.sortBy,
      title: event.title,
    });
  let runtime: RuntimeState = { kind: "metadata-loading" };
  let marketStatus: EventMarketStatus = { kind: "trading" };

  $: slug = event.slug;
  $: bundle =
    runtime.kind === "chart-loading" || runtime.kind === "ready"
      ? runtime.bundle
      : null;
  $: presentation = bundle?.presentation ?? null;
  $: connection =
    runtime.kind === "chart-loading" || runtime.kind === "ready"
      ? runtime.connection
      : "connecting";

  function flipRows(): void {
    ageRowOrientation = flipAgeRowOrientation(ageRowOrientation);
    persistAgeRowOrientation(
      { kind: "event", id: event.id },
      ageRowOrientation,
    );
  }

  function chartConnectionChanged(status: ConnectionStatus): void {
    if (runtime.kind === "chart-loading" || runtime.kind === "ready")
      runtime = { ...runtime, connection: status };
  }

  function chartReady(): void {
    if (runtime.kind !== "chart-loading") return;
    runtime = {
      kind: "ready",
      bundle: runtime.bundle,
      connection: runtime.connection,
    };
    onready();
  }

  function fail(message: string): void {
    if (runtime.kind === "failed") return;
    runtime = { kind: "failed", message };
    onfailure(message);
  }

  onMount(() => {
    let alive = true;

    void loadEventDetails(client, event).then(
      (loaded) => {
        if (!alive) return;
        runtime = {
          kind: "chart-loading",
          bundle: loaded,
          connection: "connecting",
        };
      },
      (error: unknown) => {
        if (!alive) return;
        fail(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      alive = false;
    };
  });
</script>

<article
  class="card"
  class:card--pinned={pinned}
  class:card--age-view={viewMode === "age"}
  data-event-id={event.id}
  data-event-slug={slug ?? ""}
  use:cardReorderSurface={onreorderstart}
>
  <button
    type="button"
    class="card-drag"
    aria-label="Drag to rearrange card"
    title="Drag to rearrange; arrow keys move card"
    onclick={(event) => reorderHandleClick(event, onreorderstep)}
    onkeydown={(event) => reorderHandleKeydown(event, onreorderstep)}
  >
    <svg viewBox="0 0 18 12" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.25" />
      <circle cx="9" cy="3.5" r="1.25" />
      <circle cx="14" cy="3.5" r="1.25" />
      <circle cx="4" cy="8.5" r="1.25" />
      <circle cx="9" cy="8.5" r="1.25" />
      <circle cx="14" cy="8.5" r="1.25" />
    </svg>
  </button>
  <div class="card-actions">
    <select
      class="card-view"
      aria-label="Visualization mode"
      bind:value={viewMode}
    >
      <option value="age">age</option>
      <option value="volume">volume</option>
    </select>

    {#if viewMode === "age"}
      <button
        type="button"
        class="card-row-flip"
        aria-pressed={ageRowOrientation === "negative-above"}
        aria-label={ageRowOrientation === "negative-above"
          ? "Put right-side book above the centerline"
          : "Put left-side book above the centerline"}
        title={ageRowOrientation === "negative-above"
          ? "Left side is above — click to put right side above"
          : "Right side is above — click to put left side above"}
        onclick={flipRows}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            d={ageRowOrientation === "negative-above"
              ? "M4 12h16M8 9V5m0 0L6 7m2-2 2 2m8 6v4m0 0-2-2m2 2 2-2"
              : "M4 12h16M16 9V5m0 0-2 2m2-2 2 2M8 15v4m0 0-2-2m2 2 2-2"}
          />
        </svg>
      </button>
    {/if}

    <button
      type="button"
      class="card-pin"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin event" : "Pin event across reloads"}
      title={pinned
        ? "Pinned — click to stop restoring this event on reload"
        : "Pin this event so it returns after reload"}
      onclick={() => onpin(!pinned)}
    >
      {#if pinned}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="m12 2.6 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.2l-5.72 3.02 1.09-6.38-4.63-4.51 6.4-.93L12 2.6Z"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
            d="m12 2.6 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.2l-5.72 3.02 1.09-6.38-4.63-4.51 6.4-.93L12 2.6Z"
          />
        </svg>
      {/if}
    </button>

    <button
      type="button"
      class="card-close"
      disabled={runtime.kind !== "ready"}
      aria-label={`Remove ${event.title ?? "event"}`}
      title="Remove event from dashboard"
      onclick={onremove}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          d="M6 6l12 12M18 6 6 18"
        />
      </svg>
    </button>
  </div>

  <div class="cpv-wrap">
    <EventHeader
      {event}
      {slug}
      iconUrl={presentation?.iconUrl ?? null}
      {connection}
      {marketStatus}
    />

    {#if presentation?.description}
      <EventDescription description={presentation.description} />
    {/if}

    {#if presentation && presentation.marketRules.length > 0}
      <MarketRules rules={presentation.marketRules} />
    {/if}

    {#if bundle}
      <ChartHost
        {bundle}
        {client}
        {viewMode}
        {ageRowOrientation}
        onready={chartReady}
        onfailure={fail}
        onconnection={chartConnectionChanged}
        onmarketstatus={(status) => (marketStatus = status)}
      />
    {/if}
  </div>
</article>
