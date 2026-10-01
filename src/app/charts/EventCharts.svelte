<script lang="ts">
  import type { PublicClient } from "@polymarket/client";
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
  import type { EventMarketStatus } from "../../domain/markets/marketLifecycle";
  import {
    loadStoredAgeRowOrientation,
    persistAgeRowOrientation,
  } from "./ageRowOrientationStorage";
  import ChartHost from "./ChartHost.svelte";

  export let bundle: EventDetails;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onmarketstatus: (status: EventMarketStatus) => void = () =>
    undefined;

  interface ChartGroupState {
    readonly definition: EventMarketGroup;
    orientation: AgeRowOrientation;
    ready: boolean;
    marketStatus: EventMarketStatus;
  }

  let groups: ChartGroupState[] = eventMarketGroups(bundle).map(
    (definition) => ({
      definition,
      orientation: initialOrientation(definition),
      ready: false,
      marketStatus: { kind: "trading" },
    }),
  );

  $: onmarketstatus(
    combinedMarketStatus(groups.map((group) => group.marketStatus)),
  );

  function initialOrientation(group: EventMarketGroup): AgeRowOrientation {
    const groupOrientation = loadStoredAgeRowOrientation({
      kind: "event-group",
      eventId: bundle.event.id,
      groupKey: group.key,
    });
    if (groupOrientation) return groupOrientation;

    // Preserve the old single-chart preference while migrating event cards to
    // group-local settings. Split groups intentionally start from new defaults.
    if (group.key === "all") {
      const legacyOrientation = loadStoredAgeRowOrientation({
        kind: "event",
        id: bundle.event.id,
      });
      if (legacyOrientation) return legacyOrientation;
    }
    return group.defaultAgeRowOrientation;
  }

  function flipGroupRows(group: ChartGroupState): void {
    group.orientation = flipAgeRowOrientation(group.orientation);
    groups = [...groups];
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
    if (group.ready) return;
    group.ready = true;
    if (groups.every((candidate) => candidate.ready)) onready();
  }

  function groupMarketStatusChanged(
    group: ChartGroupState,
    status: EventMarketStatus,
  ): void {
    group.marketStatus = status;
    onmarketstatus(
      combinedMarketStatus(groups.map((candidate) => candidate.marketStatus)),
    );
  }

  function combinedMarketStatus(
    statuses: Iterable<EventMarketStatus>,
  ): EventMarketStatus {
    const values = [...statuses];
    if (
      values.length > 0 &&
      values.every((status) => status.kind === "resolved")
    )
      return { kind: "resolved" };
    if (
      values.length > 0 &&
      values.every((status) => status.kind !== "trading")
    )
      return { kind: "awaiting-resolution" };
    return { kind: "trading" };
  }
</script>

{#if groups.length === 1}
  {@const group = groups[0]!}
  <ChartHost
    bundle={group.definition.bundle}
    {client}
    {viewMode}
    ageRowOrientation={group.orientation}
    onrowflip={() => flipGroupRows(group)}
    onready={() => groupReady(group)}
    {onfailure}
    onmarketstatus={(status) => groupMarketStatusChanged(group, status)}
  />
{:else}
  <div class="cpv-chart-groups">
    {#each groups as group (group.definition.key)}
      <section
        class="cpv-chart-group"
        aria-label={group.definition.label ?? undefined}
      >
        <div class="cpv-chart-group-header">
          <div class="cpv-chart-group-title">{group.definition.label}</div>
        </div>
        <ChartHost
          bundle={group.definition.bundle}
          {client}
          {viewMode}
          ageRowOrientation={group.orientation}
          onrowflip={() => flipGroupRows(group)}
          onready={() => groupReady(group)}
          {onfailure}
          onmarketstatus={(status) => groupMarketStatusChanged(group, status)}
        />
      </section>
    {/each}
  </div>
{/if}
