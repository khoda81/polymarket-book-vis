<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type {
    EventDetails,
    EventInfo,
    EventMarket,
  } from "../../domain/markets/eventDetails";
  import type { ViewMode } from "../../domain/markets/chartState";
  import type { EventMarketStatus } from "../../domain/markets/marketLifecycle";
  import type { AgeRowOrientation } from "../../chart/age/ageStripOrientation";
  import EventHeader from "./EventHeader.svelte";
  import EventDescription from "./EventDescription.svelte";
  import MarketRules from "./MarketRules.svelte";
  import EventCharts from "../charts/EventCharts.svelte";
  import { eventCardDetails } from "../../chart/configuration/subsetEventDetails";
  import { getVisualizationContext } from "../visualization/visualizationContext";

  export let event: EventInfo;
  export let bundle: EventDetails | null;
  export let standalone = false;
  export let viewMode: ViewMode;
  export let orientationFallback: AgeRowOrientation | null = null;
  export let onready: () => void = () => undefined;
  export let onfailure: (message: string) => void = () => undefined;
  let marketStatus: EventMarketStatus = { kind: "trading" };
  const { metadata } = getVisualizationContext();
  let currentBundle: EventDetails | null = null;
  let mounted = false;
  let unwatch: (() => void) | undefined;
  $: if (mounted) watchMetadata(bundle);
  $: displayedBundle = currentBundle ?? bundle;
  $: chartBundle =
    displayedBundle && standalone
      ? eventCardDetails(displayedBundle)
      : displayedBundle;
  $: currentEvent = displayedBundle?.event ?? event;
  $: presentation = displayedBundle?.presentation;
  $: ruledMarkets = (chartBundle?.markets ?? []).filter(
    (market): market is EventMarket & { readonly rule: string } =>
      market.rule !== null,
  );

  function watchMetadata(details: EventDetails | null): void {
    unwatch?.();
    currentBundle = details;
    unwatch = details
      ? metadata.watch(details, (updated) => (currentBundle = updated))
      : undefined;
  }
  onMount(() => {
    mounted = true;
  });
  onDestroy(() => unwatch?.());
</script>

<EventHeader
  event={currentEvent}
  slug={currentEvent.slug}
  iconUrl={presentation?.iconUrl ?? null}
  {marketStatus}
/>
{#if presentation?.description}
  <EventDescription description={presentation.description} />
{/if}
{#if ruledMarkets.length > 0}
  <MarketRules markets={ruledMarkets} />
{/if}
{#if chartBundle}
  <EventCharts
    bundle={chartBundle}
    {viewMode}
    {orientationFallback}
    {onready}
    {onfailure}
    onmarketstatus={(status) => (marketStatus = status)}
  />
{/if}
