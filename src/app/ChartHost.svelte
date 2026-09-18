<script lang="ts">
  import { onMount } from "svelte";
  import { PolymarketCPV } from "../component";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../lib/chartState";
  import type { EventBundle } from "../lib/eventBundle";
  import type { ChartLifecycle } from "./model";
  import { createPublicClient } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventBundle;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onstate: (state: ChartLifecycle) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void =
    () => undefined;

  let host: HTMLDivElement;
  let chart: PolymarketCPV | null = null;

  onMount(() => {
    let alive = true;
    const next = new PolymarketCPV(host, client, {
      onConnectionStatus: (status) => {
        if (alive) onconnection(status);
      },
    });
    chart = next;
    next.setViewMode(viewMode);

    void next.load(bundle).then(
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
