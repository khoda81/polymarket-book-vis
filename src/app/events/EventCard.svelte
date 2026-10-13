<script lang="ts">
  import CardActions from "../dashboard/CardActions.svelte";
  import { onMount } from "svelte";
  import EventContent from "./EventContent.svelte";
  import {
    cardReorderSurface,
    type CardReorderStart,
  } from "../dashboard/cardReorderSurface";
  import type { ViewMode } from "../../domain/markets/chartState";
  import {
    loadEventDetails,
    type EventDetails,
  } from "../../domain/markets/eventDetails";
  import { eventCardDetails } from "../../chart/configuration/subsetEventDetails";
  import { getVisualizationContext } from "../visualization/visualizationContext";
  import type { Event } from "@polymarket/client";

  type RuntimeState =
    | { readonly kind: "metadata-loading" }
    | { readonly kind: "chart-loading"; readonly bundle: EventDetails }
    | { readonly kind: "ready"; readonly bundle: EventDetails }
    | { readonly kind: "failed"; readonly message: string };

  export let event: Event;
  export let pinned: boolean;
  export let onpin: (pinned: boolean) => void;
  export let onremove: () => void;
  export let onready: () => void;
  export let onfailure: (message: string) => void;
  export let onreorderstart: (start: CardReorderStart) => void;
  export let onreorderstep: (direction: -1 | 1) => void;

  const { client } = getVisualizationContext();

  let viewMode: ViewMode = "age";
  let runtime: RuntimeState = { kind: "metadata-loading" };

  $: slug = event.slug;
  $: bundle =
    runtime.kind === "chart-loading" || runtime.kind === "ready"
      ? runtime.bundle
      : null;
  function chartReady(): void {
    if (runtime.kind !== "chart-loading") return;
    runtime = {
      kind: "ready",
      bundle: runtime.bundle,
    };
    onready();
  }

  function fail(message: string): void {
    if (runtime.kind === "failed") return;
    runtime = { kind: "failed", message };
    onfailure(message);
  }

  onMount(() => {
    let alive = true;

    void loadEventDetails(client, event).then(
      (loaded) => {
        if (!alive) return;
        runtime = {
          kind: "chart-loading",
          bundle: eventCardDetails(loaded),
        };
      },
      (error: unknown) => {
        if (!alive) return;
        fail(error instanceof Error ? error.message : String(error));
      },
    );

    return () => {
      alive = false;
    };
  });
</script>

<article
  class="card"
  class:card--pinned={pinned}
  data-event-id={event.id}
  data-event-slug={slug ?? ""}
  use:cardReorderSurface={onreorderstart}
>
  <CardActions
    kind="event"
    title={event.title}
    {pinned}
    ready={runtime.kind === "ready"}
    bind:viewMode
    {onpin}
    {onremove}
    {onreorderstep}
  />

  <div class="cpv-wrap">
    <EventContent
      {event}
      {bundle}
      {viewMode}
      onready={chartReady}
      onfailure={fail}
    />
  </div>
</article>
