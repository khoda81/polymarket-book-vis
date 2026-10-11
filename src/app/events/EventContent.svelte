<script lang="ts">
  import type { Event } from "@polymarket/client";
  import type { EventDetails } from "../../domain/markets/eventDetails";
  import type { ViewMode } from "../../domain/markets/chartState";
  import type { EventMarketStatus } from "../../domain/markets/marketLifecycle";
  import type { AgeRowOrientation } from "../../chart/age/ageStripOrientation";
  import EventHeader from "./EventHeader.svelte";
  import EventDescription from "./EventDescription.svelte";
  import MarketRules from "./MarketRules.svelte";
  import EventCharts from "../charts/EventCharts.svelte";

  export let event: Event;
  export let bundle: EventDetails | null;
  export let viewMode: ViewMode;
  export let orientationFallback: AgeRowOrientation | null = null;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  let marketStatus: EventMarketStatus = { kind: "trading" };
  $: presentation = bundle?.presentation;
</script>

<EventHeader
  {event}
  slug={event.slug}
  iconUrl={presentation?.iconUrl ?? null}
  {marketStatus}
/>
{#if presentation?.description}
  <EventDescription description={presentation.description} />
{/if}
{#if presentation && presentation.marketRules.length > 0}
  <MarketRules rules={presentation.marketRules} />
{/if}
{#if bundle}
  <EventCharts
    {bundle}
    {viewMode}
    {orientationFallback}
    {onready}
    {onfailure}
    onmarketstatus={(status) => (marketStatus = status)}
  />
{/if}
