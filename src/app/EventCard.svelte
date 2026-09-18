<script lang="ts">
  import ChartHost from "./ChartHost.svelte";
  import type {
    ChartLifecycle,
    PinState,
    ViewMode,
  } from "./model";
  import {
    createPublicClient,
    type Event,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let event: Event;
  export let client: PublicClient;
  export let pin: PinState;
  export let onpin: (pin: PinState) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;

  let viewMode: ViewMode = "age";
  let lifecycle: ChartLifecycle = { kind: "loading" };

  function setLifecycle(next: ChartLifecycle): void {
    lifecycle = next;
    if (next.kind === "ready") onready();
    if (next.kind === "failed") onfailure(next.message);
  }

  $: pinned = pin.kind === "pinned";
  $: pinnable = pin.kind !== "unavailable";
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
      disabled={lifecycle.kind === "loading"}
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

  <ChartHost
    {event}
    {client}
    {viewMode}
    onstate={setLifecycle}
  />
</article>
