<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ChartController,
    type ChartPendingState,
    type ChartRenderedState,
    type ChartRenderInput,
    type ChartSurfaceElements,
  } from "../../chart/controller";
  import {
    DEFAULT_AGE_ROW_ORIENTATION,
    type AgeRowOrientation,
  } from "../../chart/age/ageStripOrientation";
  import { opacityReference } from "../../domain/pressure/observationClock";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import {
    buildChartDefinition,
    type ChartMarketControl,
  } from "../../chart/configuration/chartDefinition";
  import { MarketGroupModel } from "../../chart/model/marketGroupModel.svelte";
  import type {
    ConnectionStatus,
    ViewMode,
  } from "../../domain/markets/chartState";
  import type { EventDetails } from "../../domain/markets/eventDetails";
  import type { EventMarketStatus } from "../../domain/markets/marketLifecycle";
  import {
    isMarketVisible,
    partitionMarketVisibility,
  } from "../../domain/markets/marketVisibility";
  import AgeRowFlipButton from "./AgeRowFlipButton.svelte";
  import { hiddenMarketDisplayOrder } from "./hiddenMarketOrder";
  import MarketControl from "./MarketControl.svelte";

  interface Props {
    bundle: EventDetails;
    viewMode: ViewMode;
    ageRowOrientation?: AgeRowOrientation;
    onready?: () => void;
    onfailure?: (message: string) => void;
    onconnection?: (status: ConnectionStatus) => void;
    onmarketstatus?: (status: EventMarketStatus) => void;
    onrowflip?: () => void;
  }

  let {
    bundle,
    viewMode,
    ageRowOrientation = DEFAULT_AGE_ROW_ORIENTATION,
    onready = () => undefined,
    onfailure = () => undefined,
    onconnection = () => undefined,
    onmarketstatus = () => undefined,
    onrowflip = () => undefined,
  }: Props = $props();

  const visualization = getVisualizationContext();
  const pressureDebug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("pressureDebug") === "1";

  // A ChartHost owns one market-group renderer for its entire component
  // lifetime. If bundle identity changes, the host itself must be recreated
  // rather than retargeting a live feed and retained renderer.
  const sourceBundle = untrack(() => bundle);
  const definition = buildChartDefinition(sourceBundle);
  const model = new MarketGroupModel(
    visualization.client,
    visualization.observations,
    definition,
  );

  let canvas: HTMLCanvasElement;
  let pressureCanvas: HTMLCanvasElement;
  let canvasWrap: HTMLDivElement;
  let toggles: HTMLDivElement;
  let chart = $state<ChartController | null>(null);
  let lastSubmitted = $state<ChartRenderInput | null>(null);
  let pendingRender = $state<ChartPendingState | null>(null);
  let lastRendered = $state<ChartRenderedState | null>(null);

  const orderedAgeControls = $derived(
    [...definition.controls].sort((a, b) => a.order - b.order),
  );
  const controlPartition = $derived(
    partitionMarketVisibility(orderedAgeControls, model.visibilityByMarketId),
  );
  const visibleControls = $derived(controlPartition.visible);
  const hiddenControls = $derived(controlPartition.hidden);
  const displayedHiddenControls = $derived(
    hiddenMarketDisplayOrder(hiddenControls, ageRowOrientation),
  );
  const toggledControls = $derived(
    viewMode === "age" ? visibleControls : definition.controls,
  );
  const globalObservationReference = $derived(
    visualization.observations.readReference(),
  );
  const currentFrontierMs = $derived(opacityReference(globalObservationReference));
  const submittedFrontierLagMs = $derived(
    lastSubmitted === null
      ? null
      : currentFrontierMs - lastSubmitted.opacityTimeMs,
  );
  const renderedFrontierLagMs = $derived(
    lastRendered === null
      ? null
      : currentFrontierMs - lastRendered.opacityTimeMs,
  );
  const submittedPressureRevisionLag = $derived(
    lastSubmitted === null
      ? null
      : model.pressureRevision - lastSubmitted.pressureRevision,
  );
  const renderedPressureRevisionLag = $derived(
    lastRendered === null
      ? null
      : model.pressureRevision - lastRendered.pressureRevision,
  );
  const debugRevisions = $derived(
    [
      model.pressureRevision,
      lastSubmitted?.pressureRevision ?? "—",
      lastRendered?.pressureRevision ?? "—",
    ].join("/"),
  );

  function userSetVisible(control: ChartMarketControl, visible: boolean): void {
    model.userSetMarketVisible(control, visible);
  }

  function debugTime(value: number): string {
    if (value <= 0) return "—";
    const date = new Date(value);
    return `${date.toLocaleTimeString([], { hour12: false })}.${String(
      date.getMilliseconds(),
    ).padStart(3, "0")}`;
  }

  function debugPending(state: ChartPendingState | null): string {
    if (!state) return "—";
    return `${state.kind} ${state.queueAgeMs.toFixed(1)}ms ×${state.requestCount}`;
  }

  function renderInput(): ChartRenderInput {
    const tuning = visualization.tuning.get();
    return {
      viewMode,
      ageRowOrientation,
      bookRevision: model.bookRevision,
      pressureRevision: model.pressureRevision,
      visibilityRevision: model.visibilityRevision,
      recordingRevision: model.recordingRevision,
      opacityTimeMs: currentFrontierMs,
      volumePerCssPixel: tuning.volumePerCssPixel,
      ghostHalfLifeMs: tuning.ghostHalfLifeMs,
    };
  }

  $effect(() => {
    onconnection(model.connectionStatus);
  });

  $effect(() => {
    onmarketstatus(model.marketStatus);
  });

  $effect(() => {
    // Always read the reactive input, even before the imperative chart exists.
    // This also gives debug mode a boundary between Svelte propagation and the
    // shared presentation queue.
    const input = renderInput();
    if (pressureDebug) lastSubmitted = input;
    chart?.update(input);
  });

  onMount(() => {
    let alive = true;
    const surface: ChartSurfaceElements = {
      canvas,
      pressureCanvas,
      canvasWrap,
      toggles,
    };
    const next = new ChartController(
      surface,
      model,
      visualization.tuning,
      visualization.presentation,
      renderInput(),
      pressureDebug ? (state) => (lastRendered = state) : undefined,
      pressureDebug ? (state) => (pendingRender = state) : undefined,
    );
    chart = next;

    void model.start().then(
      () => {
        if (alive) onready();
      },
      (error: unknown) => {
        if (alive)
          onfailure(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      alive = false;
      chart = null;
      next.destroy();
      model.destroy();
    };
  });
</script>

<div
  class="cpv-hidden-markets"
  hidden={viewMode !== "age" || hiddenControls.length === 0}
>
  {#if viewMode === "age"}
    {#each displayedHiddenControls as control (control.market.id)}
      <MarketControl
        {control}
        checked={false}
        lifecycle={model.lifecycleFor(control.market.id)}
        onchange={(checked) => userSetVisible(control, checked)}
      />
    {/each}
  {/if}
</div>

<div class="cpv-chart-stage">
  {#if pressureDebug && viewMode === "age"}
    <div
      class="cpv-pressure-debug"
      class:cpv-pressure-debug--lagging={(renderedFrontierLagMs ?? 0) !== 0 ||
        (renderedPressureRevisionLag ?? 0) !== 0}
    >
      <span>
        frontier {debugTime(currentFrontierMs)} / submitted
        {debugTime(lastSubmitted?.opacityTimeMs ?? 0)} / drawn
        {debugTime(lastRendered?.opacityTimeMs ?? 0)}
      </span>
      <span>
        Δsubmit {submittedFrontierLagMs ?? "—"}ms · Δdraw
        {renderedFrontierLagMs ?? "—"}ms
      </span>
      <span>
        rev {debugRevisions} · Δsubmit {submittedPressureRevisionLag ?? "—"} ·
        Δdraw
        {renderedPressureRevisionLag ?? "—"}
      </span>
      <span>
        draw {lastRendered?.kind ?? "—"} · queue
        {lastRendered ? lastRendered.queueDelayMs.toFixed(1) : "—"}ms · latest
        {lastRendered ? lastRendered.latestRequestDelayMs.toFixed(1) : "—"}ms
      </span>
      <span>
        CPU {lastRendered ? lastRendered.drawCpuMs.toFixed(1) : "—"}ms ·
        coalesced {lastRendered?.coalescedRequests ?? "—"}
      </span>
      <span>pending {debugPending(pendingRender)}</span>
    </div>
  {/if}

  {#if viewMode === "age" && visibleControls.length > 0}
    <div class="cpv-chart-row-flip">
      <AgeRowFlipButton orientation={ageRowOrientation} onflip={onrowflip} />
    </div>
  {/if}

  <div
    class="cpv-canvas-wrap"
    hidden={visibleControls.length === 0}
    bind:this={canvasWrap}
  >
    <canvas
      class="cpv-pressure-canvas"
      aria-hidden="true"
      bind:this={pressureCanvas}
    ></canvas>
    <canvas class="cpv-main-canvas" bind:this={canvas}></canvas>
  </div>

  <div
    class="cpv-toggles"
    class:cpv-toggles--age-axis={viewMode === "age"}
    hidden={viewMode === "age" && visibleControls.length === 0}
    bind:this={toggles}
  >
    {#each toggledControls as control (control.market.id)}
      <MarketControl
        {control}
        checked={isMarketVisible(model.visibilityFor(control.market.id))}
        lifecycle={model.lifecycleFor(control.market.id)}
        onchange={(checked) => userSetVisible(control, checked)}
      />
    {/each}
  </div>
</div>
