<script lang="ts">
  import type { AgeRowOrientation } from "../../chart/age/ageStripOrientation";

  export let orientation: AgeRowOrientation;
  export let onflip: () => void;
</script>

<button
  type="button"
  class="chart-row-flip"
  aria-pressed={orientation === "negative-above"}
  aria-label={orientation === "negative-above"
    ? "Put right-side book above the centerline"
    : "Put left-side book above the centerline"}
  title={orientation === "negative-above"
    ? "Left side is above — click to put right side above"
    : "Right side is above — click to put left side above"}
  onclick={() => onflip()}
>
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      d={orientation === "negative-above"
        ? "M4 12h16M8 9V5m0 0L6 7m2-2 2 2m8 6v4m0 0-2-2m2 2 2-2"
        : "M4 12h16M16 9V5m0 0-2 2m2-2 2 2M8 15v4m0 0-2-2m2 2 2-2"}
    />
  </svg>
</button>
