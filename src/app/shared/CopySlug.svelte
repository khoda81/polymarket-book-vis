<script lang="ts">
  import { onDestroy } from "svelte";

  export let slug: string;
  export let kind: "event" | "series";

  let feedback = "";
  let copying = false;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  async function copySlug(): Promise<void> {
    if (copying) return;
    copying = true;
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(slug);
      if (!destroyed) feedback = "Copied!";
    } catch {
      if (!destroyed) feedback = "Copy failed — try again";
    } finally {
      if (!destroyed) {
        copying = false;
        resetTimer = setTimeout(() => (feedback = ""), 2_000);
      }
    }
  }

  onDestroy(() => {
    destroyed = true;
    clearTimeout(resetTimer);
  });
</script>

<button
  type="button"
  class="cpv-event-slug"
  title={slug}
  aria-label={`Copy ${kind} slug: ${slug}`}
  aria-busy={copying}
  onclick={copySlug}
>
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if feedback === "Copied!"}
      <path d="m5 12 4 4L19 6" />
    {:else}
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    {/if}
  </svg>
  <span class="slug-text">{slug}</span>
  <span class="copy-feedback" role="status">{feedback}</span>
</button>

<style>
  svg {
    flex: 0 0 auto;
  }

  .slug-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .copy-feedback {
    flex: 0 0 auto;
    font-weight: 600;
  }

  .copy-feedback:empty {
    display: none;
  }
</style>
