<script lang="ts">
  import type { Event, Series } from "@polymarket/client";
  import CopySlug from "./CopySlug.svelte";

  export let series: Series;
  export let event: Event | null = null;

  let iconFailed = false;

  $: iconUrl =
    event?.icon?.trim() ||
    event?.image?.trim() ||
    series.icon?.trim() ||
    series.image?.trim() ||
    null;
  $: if (iconUrl) iconFailed = false;
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
</div>
