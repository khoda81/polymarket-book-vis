<script lang="ts">
  import type { ConnectionStatus } from "../lib/chartState";
  import type { Event, Series } from "@polymarket/client";

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

  function copySlug(): void {
    const slug = series.slug?.trim();
    if (!slug) return;
    void navigator.clipboard?.writeText(slug).catch(() => undefined);
  }

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
        <h5 class="cpv-title">{series.title ?? "(untitled series)"}</h5>
        {#if series.recurrence}
          <span class="series-recurrence">{series.recurrence}</span>
        {/if}
      </div>

      {#if series.slug}
        <button
          type="button"
          class="cpv-event-slug"
          title="Copy series slug"
          onclick={copySlug}
        >{series.slug}</button>
      {/if}
    </div>
  </div>

  <div class="cpv-status">
    <div class={`cpv-dot ${statusClass}`}></div>
    <span class="cpv-stxt">{statusText}</span>
  </div>
</div>
