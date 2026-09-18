<script lang="ts">
  import { onMount } from "svelte";
  import ChartHost from "./ChartHost.svelte";
  import EventDescription from "./EventDescription.svelte";
  import EventHeader from "./EventHeader.svelte";
  import MarketRules from "./MarketRules.svelte";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../lib/chartState";
  import {
    loadEventBundle,
    type EventBundle,
  } from "../lib/eventBundle";
  import {
    eventSlug,
    type PinState,
  } from "./model";
  import type { EventMarketStatus } from "../lib/marketLifecycle";
  import {
    createPublicClient,
    type Event,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  type RuntimeState =
    | { readonly kind: "metadata-loading" }
    | {
        readonly kind: "chart-loading";
        readonly bundle: EventBundle;
        readonly connection: ConnectionStatus;
      }
    | {
        readonly kind: "ready";
        readonly bundle: EventBundle;
        readonly connection: ConnectionStatus;
      }
    | { readonly kind: "failed"; readonly message: string };

  export let event: Event;
  export let client: PublicClient;
  export let pin: PinState;
  export let onpin: (pin: PinState) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;

  let viewMode: ViewMode = "age";
  let runtime: RuntimeState = { kind: "metadata-loading" };
  let marketStatus: EventMarketStatus = { kind: "trading" };

  $: slug = eventSlug(event);
  $: pinned = pin.kind === "pinned";
  $: pinnable = pin.kind !== "unavailable";
  $: bundle =
    runtime.kind === "chart-loading" || runtime.kind === "ready"
      ? runtime.bundle
      : null;
  $: presentation = bundle?.presentation ?? null;
  $: connection =
    runtime.kind === "chart-loading" || runtime.kind === "ready"
      ? runtime.connection
      : "connecting";

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

    void loadEventBundle(client, event).then(
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
  data-event-id={event.id}
  data-event-slug={pin.kind === "unavailable" ? "" : pin.slug}
>
  <div class="card-actions">
    <select
      class="card-view"
      aria-label="Visualization mode"
      bind:value={viewMode}
    >
      <option value="age">age</option>
      <option value="volume">volume</option>
    </select>

    <button
      type="button"
      class="card-pin"
      disabled={!pinnable}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin event" : "Pin event across reloads"}
      title={pinned
        ? "Pinned — click to stop restoring this event on reload"
        : "Pin this event so it returns after reload"}
      onclick={() => onpin(pin)}
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
        onready={chartReady}
        onfailure={fail}
        onconnection={chartConnectionChanged}
        onmarketstatus={(status) => (marketStatus = status)}
      />
    {/if}
  </div>
</article>
