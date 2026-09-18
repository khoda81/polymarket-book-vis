<script lang="ts">
  import type { ConnectionStatus } from "../lib/chartState";
  import type { Event } from "@polymarket/client";
  import type { EventSlug } from "./model";

  export let event: Event;
  export let slug: EventSlug | null;
  export let iconUrl: string | null;
  export let connection: ConnectionStatus;

  let iconFailed = false;

  $: if (iconUrl) iconFailed = false;

  function copySlug(): void {
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
        <h5 class="cpv-title">{event.title ?? "(untitled)"}</h5>
        {#if slug}
          <a
            class="cpv-event-link"
            href={`https://polymarket.com/event/${encodeURIComponent(slug)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open event on Polymarket"
            title="Open on Polymarket"
          >↗</a>
        {/if}
      </div>

      {#if slug}
        <button
          type="button"
          class="cpv-event-slug"
          title="Copy event slug"
          onclick={copySlug}
        >{slug}</button>
      {/if}
    </div>
  </div>

  <div class="cpv-status">
    <div class={`cpv-dot ${statusClass}`}></div>
    <span class="cpv-stxt">{statusText}</span>
  </div>
</div>
