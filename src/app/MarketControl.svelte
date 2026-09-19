<script lang="ts">
  import type { ChartMarketControl } from "../lib/chartDefinition";
  import type { MarketLifecycle } from "../lib/marketLifecycle";

  export let control: ChartMarketControl;
  export let checked: boolean;
  export let lifecycle: MarketLifecycle;
  export let onchange: (checked: boolean) => void;

  let iconFailed = false;

  $: ageStatus =
    lifecycle.kind === "resolved"
      ? `✓ ${lifecycle.winningOutcome}`
      : lifecycle.kind === "awaiting-resolution"
        ? "pending"
        : "";
</script>

<label
  data-token-id={control.tokenId}
  data-market-id={control.marketId}
  data-market-order={control.order}
  data-age-label={control.ageLabel}
  data-age-status={ageStatus}
  data-age-suppress-market-identity={control.suppressAgeIdentity}
  title={control.title}
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
    <span
      class="cpv-market-resolution"
      title={`Resolved: ${lifecycle.winningOutcome}`}
    >✓ {lifecycle.winningOutcome}</span>
  {:else if lifecycle.kind === "awaiting-resolution"}
    <span class="cpv-market-awaiting">pending</span>
  {/if}
</label>
