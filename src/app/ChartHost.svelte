<script lang="ts">
  import { onMount } from "svelte";
  import { PolymarketCPV } from "../component";
  import type {
    ChartLifecycle,
    ViewMode,
  } from "./model";
  import {
    createPublicClient,
    type Event,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let event: Event;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onstate: (state: ChartLifecycle) => void = () => undefined;

  let host: HTMLDivElement;
  let chart: PolymarketCPV | null = null;

  onMount(() => {
    let alive = true;
    const next = new PolymarketCPV(host, client);
    chart = next;
    next.setViewMode(viewMode);

    void next.load(event).then(
      () => {
        if (alive) onstate({ kind: "ready" });
      },
      (error: unknown) => {
        if (alive)
          onstate({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      },
    );

    return () => {
      alive = false;
      chart = null;
      next.destroy();
    };
  });

  $: chart?.setViewMode(viewMode);
</script>

<div bind:this={host}></div>
