<script lang="ts">
  import SeriesHeader from "./SeriesHeader.svelte";
  import SeriesTimeline from "./SeriesTimeline.svelte";
  import type { ConnectionStatus } from "../lib/chartState";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let series: Series;
  export let client: PublicClient;
  export let pinned: boolean;
  export let onpin: (pinned: boolean) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;
  export let onreorderstart: (event: PointerEvent) => void;

  let connection: ConnectionStatus = "connecting";
  let anchorEvent: Event | null = null;
  let ready = false;

  function timelineReady(): void {
    if (ready) return;
    ready = true;
    onready();
  }
</script>

<article
  class="card series-card"
  class:card--pinned={pinned}
  data-series-id={String(series.id)}
>
  <div class="card-actions">
    <button
      type="button"
      class="card-drag"
      aria-label="Rearrange card"
      title="Drag to rearrange"
      onpointerdown={onreorderstart}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="5" cy="4" r="1.25" />
        <circle cx="13" cy="4" r="1.25" />
        <circle cx="5" cy="9" r="1.25" />
        <circle cx="13" cy="9" r="1.25" />
        <circle cx="5" cy="14" r="1.25" />
        <circle cx="13" cy="14" r="1.25" />
      </svg>
    </button>

    <button
      type="button"
      class="card-pin"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin series" : "Pin series across reloads"}
      title={pinned
        ? "Pinned — click to stop restoring this series on reload"
        : "Pin this series so it returns after reload"}
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
      disabled={!ready}
      aria-label={`Remove ${series.title ?? "series"}`}
      title="Remove series from dashboard"
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
    <SeriesHeader {series} event={anchorEvent} {connection} />

    {#if series.description?.trim()}
      <p class="cpv-event-description series-description">
        {series.description}
      </p>
    {/if}

    <SeriesTimeline
      {series}
      {client}
      onready={timelineReady}
      onfailure={onfailure}
      onconnection={(status) => (connection = status)}
      onanchorevent={(event) => (anchorEvent = event)}
    />
  </div>
</article>
