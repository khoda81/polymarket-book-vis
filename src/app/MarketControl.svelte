<script lang="ts">
  import type { ChartMarketControl } from "../lib/chartDefinition";
  import type { MarketLifecycle } from "../lib/marketLifecycle";

  export let control: ChartMarketControl;
  export let checked: boolean;
  export let lifecycle: MarketLifecycle;
  export let onchange: (checked: boolean) => void;

  let iconFailed = false;

  $: ageStatus = lifecycle.kind === "awaiting-resolution" ? "pending" : "";
  $: resolutionSide =
    lifecycle.kind !== "resolved"
      ? ""
      : lifecycle.winningTokenId === control.tokenId
        ? "primary"
        : control.market.outcomes.no.tokenId !== null &&
            lifecycle.winningTokenId === control.market.outcomes.no.tokenId
          ? "opposite"
          : "";
  $: resolutionOutcome =
    lifecycle.kind !== "resolved"
      ? ""
      : resolutionSide === "primary"
        ? control.market.outcomes.yes.label || lifecycle.winningOutcome
        : resolutionSide === "opposite"
          ? control.market.outcomes.no.label || lifecycle.winningOutcome
          : lifecycle.winningOutcome;
  $: resolutionColor =
    resolutionSide === "primary"
      ? control.primaryColor
      : resolutionSide === "opposite"
        ? control.oppositeColor
        : "";
</script>

<label
  data-token-id={control.tokenId}
  data-market-id={control.market.id}
  data-market-order={control.order}
  data-age-label={control.ageLabel}
  data-age-status={ageStatus}
  data-age-resolution-side={resolutionSide}
  data-age-resolution-outcome={resolutionOutcome}
  data-age-suppress-market-identity={control.suppressAgeIdentity}
  title={control.title}
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
    style:background={control.dotColor}
    aria-hidden="true"
  ></span>
  {#if control.iconUrl && !iconFailed}
    <img
      class="cpv-market-icon"
      src={control.iconUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      onerror={() => (iconFailed = true)}
    />
  {/if}
  <span class="cpv-market-label-text">{control.title}</span>
  {#if lifecycle.kind === "resolved"}
    <span class="cpv-market-resolution-hidden">
      · {resolutionOutcome}
    </span>
  {:else if lifecycle.kind === "awaiting-resolution"}
    <span class="cpv-market-awaiting">pending</span>
  {/if}
</label>
