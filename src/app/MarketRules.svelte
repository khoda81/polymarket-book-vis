<script lang="ts">
  import type { MarketRule } from "../lib/eventBundle";

  export let rules: readonly MarketRule[];
</script>

<details class="cpv-market-rules">
  <summary>
    {rules.length === 1 ? "Market rules" : `Market rules · ${rules.length}`}
  </summary>
  <div class="cpv-market-rules-list">
    {#each rules as rule (rule.marketId)}
      <details class="cpv-market-rule">
        <summary>{rule.title}</summary>
        <div class="cpv-market-rule-body">{rule.body}</div>
      </details>
    {/each}
  </div>
</details>
