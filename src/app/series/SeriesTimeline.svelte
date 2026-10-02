<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import AgeRowFlipButton from "../charts/AgeRowFlipButton.svelte";
  import {
    SeriesTimelineView,
    type SeriesTimelineRenderInput,
  } from "../../chart/series/seriesTimelineView";
  import {
    DEFAULT_AGE_ROW_ORIENTATION,
    type AgeRowOrientation,
  } from "../../chart/age/ageStripOrientation";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import type { ObservationPoint } from "../../domain/pressure/observationClock";
  import type { ConnectionStatus } from "../../domain/markets/chartState";
  import type { Event, Series } from "@polymarket/client";

  interface Props {
    series: Series;
    ageRowOrientation?: AgeRowOrientation;
    onready?: () => void;
    onfailure?: (message: string) => void;
    onconnection?: (status: ConnectionStatus) => void;
    onanchorevent?: (event: Event | null) => void;
    onrowflip?: () => void;
  }

  let {
    series,
    ageRowOrientation = DEFAULT_AGE_ROW_ORIENTATION,
    onready = () => undefined,
    onfailure = () => undefined,
    onconnection = () => undefined,
    onanchorevent = () => undefined,
    onrowflip = () => undefined,
  }: Props = $props();

  const visualization = getVisualizationContext();
  const observationPointsByToken = new SvelteMap<string, ObservationPoint>();

  let canvas: HTMLCanvasElement;
  let pressureCanvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let view = $state<SeriesTimelineView | null>(null);
  let following = $state(true);
  let jumpValue = $state("");
  let eventCount = $state(0);
  let message = $state("");

  function renderInput(): SeriesTimelineRenderInput {
    const tuning = visualization.tuning.get();
    return {
      ageRowOrientation,
      observationReference: visualization.observations.readReference(),
      volumePerCssPixel: tuning.volumePerCssPixel,
      ghostHalfLifeMs: tuning.ghostHalfLifeMs,
    };
  }

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

  $effect(() => {
    view?.updateRenderInputs(renderInput());
  });

  onMount(() => {
    const timeline = new SeriesTimelineView(
      canvas,
      pressureCanvas,
      canvasWrap,
      visualization.client,
      observationPointsByToken,
      visualization.observations,
      visualization.tuning,
      visualization.presentation,
      series,
      renderInput(),
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
