<script lang="ts">
  import type { ConnectionStatus } from "../lib/chartState";
  import type { EventMarketStatus } from "../lib/marketLifecycle";
  import type { Event } from "@polymarket/client";
  import type { EventSlug } from "./model";
  import CopySlug from "./CopySlug.svelte";

  export let event: Event;
  export let slug: EventSlug | null;
  export let iconUrl: string | null;
  export let connection: ConnectionStatus;
  export let marketStatus: EventMarketStatus;

  let iconFailed = false;

  $: if (iconUrl) iconFailed = false;

  $: statusClass =
    marketStatus.kind === "resolved"
      ? "cpv-dot--resolved"
      : marketStatus.kind === "awaiting-resolution"
        ? "cpv-dot--conn"
        : connection === "live"
          ? "cpv-dot--live"
          : connection === "connecting"
            ? "cpv-dot--conn"
            : "cpv-dot--err";
  $: statusText =
    marketStatus.kind === "resolved"
      ? "resolved"
      : marketStatus.kind === "awaiting-resolution"
        ? "awaiting resolution"
        : connection === "live"
          ? "live"
          : connection === "connecting"
            ? "connecting…"
            : "disconnected";
</script>

<div class="cpv-header">
  <div class="cpv-heading">
    {#if iconUrl && !iconFailed}
      <img
        class="cpv-event-icon"
        src={iconUrl}
        alt=""
        aria-hidden="true"
        onerror={() => (iconFailed = true)}
      />
    {/if}

    <div class="cpv-heading-copy">
      <div class="cpv-title-line">
        <h5 class="cpv-title" title={event.title ?? "(untitled)"}>
          {event.title ?? "(untitled)"}
        </h5>
        {#if slug}
          <a
            class="cpv-event-link"
            href={`https://polymarket.com/event/${encodeURIComponent(slug)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open event on Polymarket"
            title="Open on Polymarket">↗</a
          >
        {/if}
      </div>

      {#if slug}
        <CopySlug {slug} kind="event" />
      {/if}
    </div>
  </div>

  <div class="cpv-status">
    <div class={`cpv-dot ${statusClass}`}></div>
    <span class="cpv-stxt">{statusText}</span>
  </div>
</div>
