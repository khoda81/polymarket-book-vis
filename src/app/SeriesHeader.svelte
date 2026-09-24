<script lang="ts">
  import type { ConnectionStatus } from "../lib/chartState";
  import type { Event, Series } from "@polymarket/client";
  import CopySlug from "./CopySlug.svelte";

  export let series: Series;
  export let event: Event | null = null;
  export let connection: ConnectionStatus;

  let iconFailed = false;

  $: iconUrl =
    event?.icon?.trim() ||
    event?.image?.trim() ||
    series.icon?.trim() ||
    series.image?.trim() ||
    null;
  $: if (iconUrl) iconFailed = false;

  $: statusClass =
    connection === "live"
      ? "cpv-dot--live"
      : connection === "connecting"
        ? "cpv-dot--conn"
        : "cpv-dot--err";
  $: statusText =
    connection === "live"
      ? "live series"
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
        <h5 class="cpv-title" title={series.title ?? "(untitled series)"}>
          {series.title ?? "(untitled series)"}
        </h5>
        {#if series.recurrence}
          <span class="series-recurrence">{series.recurrence}</span>
        {/if}
      </div>

      {#if series.slug}
        <CopySlug slug={series.slug.trim()} kind="series" />
      {/if}
    </div>
  </div>

  <div class="cpv-status">
    <div class={`cpv-dot ${statusClass}`}></div>
    <span class="cpv-stxt">{statusText}</span>
  </div>
</div>
