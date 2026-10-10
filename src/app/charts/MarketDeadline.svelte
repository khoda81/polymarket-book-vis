<script lang="ts">
  import { onMount } from "svelte";
  import { deadlineDisplay } from "../../domain/markets/marketDeadline";

  export let deadlineMs: number | null;

  let element: HTMLSpanElement;
  let refresh: () => void = () => undefined;
  $: (deadlineMs, refresh());
  $: title =
    deadlineMs === null
      ? "Polymarket does not report an end date for this market"
      : `Reported end: ${new Date(deadlineMs).toLocaleString()} (${new Date(deadlineMs).toISOString()})`;

  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    refresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      const display = deadlineDisplay(deadlineMs, Date.now());
      const node = element.firstChild as Text;
      if (node.data !== display.text) node.data = display.text;
      if (display.nextChangeMs !== null)
        timer = setTimeout(
          refresh,
          Math.min(2_147_483_647, Math.ceil(display.nextChangeMs) + 1),
        );
    };
    refresh();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  });
</script>

<span
  class="cpv-market-deadline"
  data-masonry-layout-neutral
  data-deadline-ms={deadlineMs ?? undefined}
  {title}
  bind:this={element}>{deadlineDisplay(deadlineMs, Date.now()).text}</span
>
