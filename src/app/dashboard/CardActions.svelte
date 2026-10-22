<script lang="ts">
  import type { ViewMode } from "../../domain/markets/chartState";
  import {
    reorderHandleClick,
    reorderHandleKeydown,
  } from "./cardReorderSurface";
  export let kind: "event" | "series";
  export let title: string | null | undefined;
  export let pinned: boolean;
  export let ready: boolean;
  export let viewMode: ViewMode;
  export let onpin: (pinned: boolean) => void;
  export let onremove: () => void;
  export let onreorderstep: (direction: -1 | 1) => void;
</script>

<div class="card-controls">
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

    <button
      type="button"
      class="card-pin"
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${kind}` : `Pin ${kind} across reloads`}
      title={pinned
        ? `Pinned — click to stop restoring this ${kind} on reload`
        : `Pin this ${kind} so it returns after reload`}
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
      aria-label={`Remove ${title ?? kind}`}
      title={`Remove ${kind} from dashboard`}
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
</div>
