<script lang="ts">
  import type { ChartMarketControl } from "../lib/chartDefinition";

  export let control: ChartMarketControl;
  export let checked: boolean;
  export let onchange: (checked: boolean) => void;

  let iconFailed = false;
</script>

<label
  data-token-id={control.tokenId}
  data-market-id={control.marketId}
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
</label>
