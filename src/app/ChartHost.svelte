<script lang="ts">
  import { onMount } from "svelte";
  import { ChartController } from "../chart/controller";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../lib/chartState";
  import type { EventBundle } from "../lib/eventBundle";
  import { createPublicClient } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventBundle;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void =
    () => undefined;

  let host: HTMLDivElement;
  let chart: ChartController | null = null;

  onMount(() => {
    let alive = true;
    const next = new ChartController(host, client, {
      onConnectionStatus: (status) => {
        if (alive) onconnection(status);
      },
    });
    chart = next;
    next.setViewMode(viewMode);

    void next.load(bundle).then(
      () => {
        if (alive) onready();
      },
      (error: unknown) => {
        if (alive)
          onfailure(
            error instanceof Error ? error.message : String(error),
          );
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
