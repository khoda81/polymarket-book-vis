<script lang="ts">
  import type { ChartMarketControl } from "../../chart/configuration/chartDefinition";
  import {
    resolvedOutcome,
    type MarketLifecycle,
  } from "../../domain/markets/marketLifecycle";
  import { marketTimeTooltip } from "../../domain/markets/marketDeadline";
  import MarketDeadline from "./MarketDeadline.svelte";

  export let control: ChartMarketControl;
  export let checked: boolean;
  export let lifecycle: MarketLifecycle;
  export let onchange: (checked: boolean) => void;
  export let showDeadline = true;

  let iconFailed = false;

  $: market = control.market;
  $: ageStatus = lifecycle.kind === "awaiting-resolution" ? "pending" : "";
  $: resolution =
    lifecycle.kind === "resolved" ? resolvedOutcome(market, lifecycle) : null;
  $: resolutionOutcome = resolution?.label ?? "";
  $: resolutionColor =
    resolution?.side === "yes"
      ? control.primaryColor
      : resolution?.side === "no"
        ? control.oppositeColor
        : "";
</script>

<label
  data-row-key={control.market.id}
  data-age-label={control.ageLabel ?? ""}
  data-age-status={ageStatus}
  data-age-suppress-market-identity={control.ageLabel === null}
  title={market.title}
  style={resolutionColor
    ? `--cpv-resolution-color: ${resolutionColor}`
    : undefined}
>
  <input
    type="checkbox"
    {checked}
    onchange={(event) =>
      onchange((event.currentTarget as HTMLInputElement).checked)}
  />
  <span
    class="cpv-market-dot"
    style:background={control.primaryColor}
    aria-hidden="true"
  ></span>
  {#if market.iconUrl && !iconFailed}
    <img
      class="cpv-market-icon"
      src={market.iconUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onerror={() => (iconFailed = true)}
    />
  {/if}
  <span class="cpv-market-copy">
    <span class="cpv-market-label-text">{market.title}</span>
    {#if showDeadline}
      <span class="cpv-market-meta">
        {#if lifecycle.kind === "resolved"}
          <span
            class="cpv-market-state"
            title={`Resolved · ${resolutionOutcome}\n${marketTimeTooltip(market.timeMarker)}`}
            >Resolved · {resolutionOutcome}</span
          >
        {:else}
          <MarketDeadline marker={market.timeMarker} />
          {#if market.closed}<span class="cpv-market-state">closed</span>{/if}
          {#if market.archived}<span class="cpv-market-state">archived</span
            >{/if}
        {/if}
      </span>
    {/if}
  </span>
  {#if lifecycle.kind === "resolved"}
    <span class="cpv-market-resolution-hidden">
      · {resolutionOutcome}
    </span>
  {:else if lifecycle.kind === "awaiting-resolution"}
    <span class="cpv-market-awaiting">pending</span>
  {/if}
</label>
