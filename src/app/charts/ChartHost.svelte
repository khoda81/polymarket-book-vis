<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ChartController,
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

  function userSetVisible(control: ChartMarketControl, visible: boolean): void {
    model.userSetMarketVisible(control, visible);
  }

  function renderInput(): ChartRenderInput {
    const tuning = visualization.tuning.get();
    const reference = visualization.observations.readReference();

    return {
      viewMode,
      ageRowOrientation,
      bookRevision: model.bookRevision,
      pressureRevision: model.pressureRevision,
      visibilityRevision: model.visibilityRevision,
      recordingRevision: model.recordingRevision,
      opacityTimeMs: opacityReference(reference),
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
    chart?.update(renderInput());
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
      renderInput(),
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
