<script lang="ts">
  import {
    flipAgeRowOrientation,
    type AgeRowOrientation,
  } from "../chart/ageStripOrientation";
  import type { ConnectionStatus, ViewMode } from "../lib/chartState";
  import type { EventDetails } from "../lib/eventDetails";
  import {
    eventMarketGroups,
    type EventMarketGroup,
    type EventMarketGroupKey,
  } from "../lib/eventMarketGroups";
  import type { EventMarketStatus } from "../lib/marketLifecycle";
  import {
    loadStoredAgeRowOrientation,
    persistAgeRowOrientation,
  } from "./ageRowOrientationStorage";
  import ChartHost from "./ChartHost.svelte";
  import { createPublicClient } from "@polymarket/client";

  type PublicClient = ReturnType<typeof createPublicClient>;

  export let bundle: EventDetails;
  export let client: PublicClient;
  export let viewMode: ViewMode;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  export let onconnection: (status: ConnectionStatus) => void = () => undefined;
  export let onmarketstatus: (status: EventMarketStatus) => void = () =>
    undefined;

  const groups = eventMarketGroups(bundle);
  let orientationByGroup = new Map<EventMarketGroupKey, AgeRowOrientation>(
    groups.map((group) => [group.key, initialOrientation(group)]),
  );
  let readyGroups = new Set<EventMarketGroupKey>();
  let readyEmitted = false;
  let connectionByGroup = new Map<EventMarketGroupKey, ConnectionStatus>(
    groups.map((group) => [group.key, "connecting"]),
  );
  let marketStatusByGroup = new Map<EventMarketGroupKey, EventMarketStatus>(
    groups.map((group) => [group.key, { kind: "trading" }]),
  );

  $: onconnection(combinedConnection(connectionByGroup.values()));
  $: onmarketstatus(combinedMarketStatus(marketStatusByGroup.values()));

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

  function groupOrientation(key: EventMarketGroupKey): AgeRowOrientation {
    return orientationByGroup.get(key) ?? "negative-above";
  }

  function flipGroupRows(group: EventMarketGroup): void {
    const orientation = flipAgeRowOrientation(groupOrientation(group.key));
    orientationByGroup = new Map(orientationByGroup);
    orientationByGroup.set(group.key, orientation);
    persistAgeRowOrientation(
      {
        kind: "event-group",
        eventId: bundle.event.id,
        groupKey: group.key,
      },
      orientation,
    );
  }

  function groupReady(key: EventMarketGroupKey): void {
    readyGroups = new Set(readyGroups);
    readyGroups.add(key);
    if (!readyEmitted && readyGroups.size === groups.length) {
      readyEmitted = true;
      onready();
    }
  }

  function groupConnectionChanged(
    key: EventMarketGroupKey,
    status: ConnectionStatus,
  ): void {
    connectionByGroup = new Map(connectionByGroup);
    connectionByGroup.set(key, status);
  }

  function groupMarketStatusChanged(
    key: EventMarketGroupKey,
    status: EventMarketStatus,
  ): void {
    marketStatusByGroup = new Map(marketStatusByGroup);
    marketStatusByGroup.set(key, status);
  }

  function combinedConnection(
    statuses: Iterable<ConnectionStatus>,
  ): ConnectionStatus {
    const values = [...statuses];
    if (values.some((status) => status === "disconnected"))
      return "disconnected";
    if (values.some((status) => status === "connecting")) return "connecting";
    return "live";
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
    bundle={group.bundle}
    {client}
    {viewMode}
    ageRowOrientation={orientationByGroup.get(group.key) ?? "negative-above"}
    onrowflip={() => flipGroupRows(group)}
    onready={() => groupReady(group.key)}
    {onfailure}
    onconnection={(status) => groupConnectionChanged(group.key, status)}
    onmarketstatus={(status) => groupMarketStatusChanged(group.key, status)}
  />
{:else}
  <div class="cpv-chart-groups">
    {#each groups as group (group.key)}
      <section class="cpv-chart-group" aria-label={group.label ?? undefined}>
        <div class="cpv-chart-group-header">
          <div class="cpv-chart-group-title">{group.label}</div>
        </div>
        <ChartHost
          bundle={group.bundle}
          {client}
          {viewMode}
          ageRowOrientation={orientationByGroup.get(group.key) ??
            "negative-above"}
          onrowflip={() => flipGroupRows(group)}
          onready={() => groupReady(group.key)}
          {onfailure}
          onconnection={(status) => groupConnectionChanged(group.key, status)}
          onmarketstatus={(status) =>
            groupMarketStatusChanged(group.key, status)}
        />
      </section>
    {/each}
  </div>
{/if}
