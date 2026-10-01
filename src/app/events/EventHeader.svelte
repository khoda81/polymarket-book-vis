<script lang="ts">
  import type { EventMarketStatus } from "../../domain/markets/marketLifecycle";
  import type { Event } from "@polymarket/client";
  import CopySlug from "../shared/CopySlug.svelte";

  export let event: Event;
  export let slug: string | null | undefined;
  export let iconUrl: string | null;
  export let marketStatus: EventMarketStatus;

  let iconFailed = false;

  $: if (iconUrl) iconFailed = false;

  $: statusClass =
    marketStatus.kind === "resolved" ? "cpv-dot--resolved" : "cpv-dot--conn";
  $: statusText =
    marketStatus.kind === "resolved" ? "resolved" : "awaiting resolution";
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

  {#if marketStatus.kind !== "trading"}
    <div class="cpv-status">
      <div class={`cpv-dot ${statusClass}`}></div>
      <span class="cpv-stxt">{statusText}</span>
    </div>
  {/if}
</div>
