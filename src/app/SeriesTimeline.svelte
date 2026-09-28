<script lang="ts">
  import { onMount } from "svelte";
  import AgeRowFlipButton from "./AgeRowFlipButton.svelte";
  import { SeriesTimelineView } from "../chart/seriesTimelineView";
  import {
    DEFAULT_AGE_ROW_ORIENTATION,
    type AgeRowOrientation,
  } from "../chart/ageStripOrientation";
  import type { ConnectionStatus } from "../lib/chartState";
  import {
    createPublicClient,
    type Event,
    type Series,
  } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let series: Series;
  export let client: PublicClient;
  export let ageRowOrientation: AgeRowOrientation = DEFAULT_AGE_ROW_ORIENTATION;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void = () => undefined;
  export let onanchorevent: (event: Event | null) => void = () => undefined;
  export let onrowflip: () => void = () => undefined;

  let canvas: HTMLCanvasElement;
  let pressureCanvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let view: SeriesTimelineView | null = null;
  let following = true;
  let jumpValue = "";
  let eventCount = 0;
  let message = "";

  function jump(): void {
    if (!jumpValue) return;
    const timeMs = new Date(jumpValue).getTime();
    if (!Number.isFinite(timeMs)) {
      message = "Invalid time";
      return;
    }
    message = "";
    view?.jumpTo(timeMs);
  }

  function returnLive(): void {
    message = "";
    view?.followLive();
  }

  $: view?.setAgeRowOrientation(ageRowOrientation);

  onMount(() => {
    const timeline = new SeriesTimelineView(
      canvas,
      pressureCanvas,
      canvasWrap,
      client,
      series,
      {
        onConnectionStatus: onconnection,
        onFollowingChanged: (value) => {
          following = value;
        },
        onWindowChanged: (count) => {
          eventCount = count;
          message = "";
        },
        onAnchorEventChanged: onanchorevent,
        onError: (error) => {
          message = error;
        },
      },
    );
    view = timeline;
    timeline.setAgeRowOrientation(ageRowOrientation);

    void timeline.start().then(
      () => onready(),
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        message = text;
        onfailure(text);
      },
    );

    return () => {
      view = null;
      timeline.destroy();
    };
  });
</script>

<div class="series-nav">
  <button
    type="button"
    class="series-live-button"
    class:series-live-button--active={following}
    aria-pressed={following}
    onclick={returnLive}
  >
    <span class="series-live-dot"></span>
    LIVE
  </button>

  <form
    class="series-jump-form"
    onsubmit={(event) => {
      event.preventDefault();
      jump();
    }}
  >
    <label for={`series-jump-${series.id}`}>Jump to</label>
    <input
      id={`series-jump-${series.id}`}
      type="datetime-local"
      bind:value={jumpValue}
    />
    <button type="submit">Go</button>
  </form>

  <span class="series-nav-status" aria-live="polite">
    {#if message}
      {message}
    {:else if eventCount > 0}
      {eventCount} cached
    {:else}
      loading…
    {/if}
  </span>
</div>

<div class="cpv-chart-stage">
  <div class="cpv-chart-row-flip">
    <AgeRowFlipButton orientation={ageRowOrientation} onflip={onrowflip} />
  </div>

  <div class="cpv-canvas-wrap series-canvas-wrap" bind:this={canvasWrap}>
    <canvas
      class="cpv-pressure-canvas"
      aria-hidden="true"
      bind:this={pressureCanvas}
    ></canvas>
    <canvas
      class="cpv-main-canvas"
      bind:this={canvas}
      aria-label="Scrollable series market timeline"
    ></canvas>
  </div>
</div>
