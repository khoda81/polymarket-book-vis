<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import {
    flipAgeRowOrientation,
    type AgeRowOrientation,
  } from "../../chart/age/ageStripOrientation";
  import type { ViewMode } from "../../domain/markets/chartState";
  import type { EventDetails } from "../../domain/markets/eventDetails";
  import {
    eventMarketGroups,
    type EventMarketGroup,
  } from "../../chart/configuration/eventMarketGroups";
  import { buildChartDefinition } from "../../chart/configuration/chartDefinition";
  import { MarketGroupModel } from "../../chart/model/marketGroupModel.svelte";
  import {
    summarizeEventMarketStatus,
    type EventMarketStatus,
  } from "../../domain/markets/marketLifecycle";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import {
    loadStoredAgeRowOrientation,
    persistAgeRowOrientation,
  } from "./ageRowOrientationStorage";
  import ChartHost from "./ChartHost.svelte";

  let {
    bundle,
    viewMode,
    orientationFallback = null,
    onready = () => undefined,
    onfailure = () => undefined,
    onmarketstatus = () => undefined,
  }: {
    bundle: EventDetails;
    viewMode: ViewMode;
    orientationFallback?: AgeRowOrientation | null;
    onready?: () => void;
    onfailure?: (message: string) => void;
    onmarketstatus?: (status: EventMarketStatus) => void;
  } = $props();
  interface ChartGroupState {
    readonly definition: EventMarketGroup;
    readonly model: MarketGroupModel;
    orientation: AgeRowOrientation;
    ready: boolean;
  }
  const visualization = getVisualizationContext();
  let groups = $state<ChartGroupState[]>([]);

  $effect(() => {
    const definitions = eventMarketGroups(bundle);
    untrack(() => {
      const existing = new Map(
        groups.map((group) => [group.definition.key, group]),
      );
      groups = definitions.map((definition) => {
        const previous = existing.get(definition.key);
        existing.delete(definition.key);
        const chartDefinition = buildChartDefinition(definition.bundle);
        if (previous) {
          previous.model.updateDefinition(chartDefinition);
          return { ...previous, definition };
        }
        return {
          definition,
          model: new MarketGroupModel(
            visualization.client,
            visualization.observations,
            chartDefinition,
            visualization.markets,
            (message) => onfailure(message),
          ),
          orientation: initialOrientation(definition),
          ready: false,
        };
      });
      for (const group of existing.values()) group.model.destroy();
    });
  });
  $effect(() =>
    onmarketstatus(
      summarizeEventMarketStatus(
        groups.flatMap((group) =>
          group.model.definition.controls.map((control) =>
            group.model.lifecycleFor(control.market.id),
          ),
        ),
      ),
    ),
  );
  onDestroy(() => {
    for (const group of groups) group.model.destroy();
  });

  function initialOrientation(group: EventMarketGroup): AgeRowOrientation {
    return (
      loadStoredAgeRowOrientation({
        kind: "event-group",
        eventId: bundle.event.id,
        groupKey: group.key,
      }) ??
      (group.key === "all"
        ? loadStoredAgeRowOrientation({ kind: "event", id: bundle.event.id })
        : null) ??
      orientationFallback ??
      group.defaultAgeRowOrientation
    );
  }
  function flipGroupRows(group: ChartGroupState): void {
    group.orientation = flipAgeRowOrientation(group.orientation);
    persistAgeRowOrientation(
      {
        kind: "event-group",
        eventId: bundle.event.id,
        groupKey: group.definition.key,
      },
      group.orientation,
    );
  }
  function groupReady(group: ChartGroupState): void {
    group.ready = true;
    if (groups.every((candidate) => candidate.ready)) onready();
  }
</script>

<div class="cpv-chart-groups">
  {#each groups as group (group.definition.key)}
    <section
      class:cpv-chart-group={groups.length > 1}
      aria-label={group.definition.label ?? undefined}
    >
      {#if group.definition.label}
        <div class="cpv-chart-group-header">
          <div class="cpv-chart-group-title">{group.definition.label}</div>
        </div>
      {/if}
      <ChartHost
        model={group.model}
        {viewMode}
        ageRowOrientation={group.orientation}
        onrowflip={() => flipGroupRows(group)}
        onready={() => groupReady(group)}
        {onfailure}
      />
    </section>
  {/each}
</div>
