<script lang="ts">
  import type { EventMarket } from "../../domain/markets/eventDetails";

  /** Markets that carry rules of their own. */
  export let markets: readonly (EventMarket & { readonly rule: string })[];
</script>

<details class="cpv-market-rules">
  <summary>
    {markets.length === 1 ? "Market rules" : `Market rules · ${markets.length}`}
  </summary>
  <div class="cpv-market-rules-list">
    {#each markets as market (market.id)}
      <details class="cpv-market-rule">
        <summary>{market.title}</summary>
        <div class="cpv-market-rule-body">{market.rule}</div>
      </details>
    {/each}
  </div>
</details>
